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
const { EventEmitter } = require('node:events');
const { JSDOM } = require('jsdom');
const { typed, png, ftyp, pdf, ascii } = require('../helpers/attachment-bytes.js');
const { makeTempDir } = require('../helpers/workspace.js');
const config = require('../../lib/config.js');
const { receiveAttachments, createReceiver, whenReceived } = require('../../lib/attachments/receive.js');

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

// The browser pasting into the field: `files` on the clipboard, with `text`
// beside them when given. Returns the event, to read its default.
function paste(p, files, text = '') {
  const event = new p.w.Event('paste', { bubbles: true, cancelable: true });
  const types = (files.length ? ['Files'] : []).concat(text ? ['text/plain'] : []);
  Object.defineProperty(event, 'clipboardData', { value: { files, types, getData: (type) => (type === 'text/plain' ? text : '') } });
  p.$('msg-input').dispatchEvent(event);
  return event;
}

// The browser's drag as one event of `type` on `target`: carrying `files`,
// or only the `types` given. Returns the event, to read its default.
function drag(p, target, type, { files = [], types = files.length ? ['Files'] : ['text/plain'], relatedTarget = null } = {}) {
  const event = new p.w.MouseEvent(type, { bubbles: true, cancelable: true, relatedTarget, clientY: 1 });
  Object.defineProperty(event, 'dataTransfer', {
    value: { types, files, dropEffect: 'none', effectAllowed: 'all', setData() {}, getData: () => '' },
  });
  target.dispatchEvent(event);
  return event;
}
// A drag of `files` onto `target` and dropped there, settled once `count`
// chips show. Returns the drop.
async function dropped(p, target, files, count) {
  drag(p, target, 'dragenter', { files });
  drag(p, target, 'dragover', { files });
  const event = drag(p, target, 'drop', { files });
  await until(() => p.chips().length === count, `${count} chips`);
  return event;
}

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

describe('adds to a conversation run one after another', () => {
  const SIXTH = 'That would make 6 files; the limit is 5 per message';
  const settled = () => new Promise((resolve) => setTimeout(resolve, 20));
  const frames = (p) => Array.from(p.w.ws.sent).filter((raw) => raw.startsWith('{"type":"chat"'));

  // Text files named `held` added, then an add of e.txt whose read waits for
  // `release`, and an add of f.txt begun before it settles, each through the
  // one handler a pick and a drop both call.
  async function overlapping(p, held) {
    await pick(p, ...held.map((n) => p.file(n)));
    const { file, release } = heldRead(p, 'e.txt');
    const first = p.w.addFiles([file], 'pick');
    const extra = p.file('f.txt');
    const second = p.w.addFiles([extra], 'drop');
    return { first, second, release, extra, both: () => Promise.all([first, second]) };
  }

  test('a second add begun before the first settles waits for it, and is refused on the count the first left', async () => {
    const p = page();
    needs(p);
    type(p, 'see these');
    const { first, second, release, both } = await overlapping(p, ['a.txt', 'b.txt', 'c.txt', 'd.txt']);
    let secondSettled = false;
    second.then(() => { secondSettled = true; });
    // Read the moment the first settles, before the second's turn begins.
    const atFirst = first.then(() => ({ secondSettled, ready: p.w.sendReady('see these') }));
    assert.strictEqual(p.w.sendReady('see these'), false, 'not ready while both run');
    await settled();
    assert.deepStrictEqual(p.chips(), ['a.txt', 'b.txt', 'c.txt', 'd.txt'], 'the second waits, attaching nothing while the first is read');
    assert.strictEqual(p.w.sendReady('see these'), false, 'still not ready');
    release();
    assert.deepStrictEqual(await atFirst, { secondSettled: false, ready: false }, 'not ready when the first settles, the second still to run');
    await both();
    assert.deepStrictEqual(p.chips(), ['a.txt', 'b.txt', 'c.txt', 'd.txt', 'e.txt']);
    assert.deepStrictEqual(p.notices(), [{ title: 'f.txt', text: SIXTH }]);
    assert.strictEqual(p.w.sendReady('see these'), true, 'ready once both have settled');
  });

  test('two adds begun together with room for both attach every file, in the order the adds began', async () => {
    const p = page();
    needs(p);
    const { release, both } = await overlapping(p, ['a.txt', 'b.txt', 'c.txt']);
    await settled();
    release();
    await both();
    assert.deepStrictEqual(p.chips(), ['a.txt', 'b.txt', 'c.txt', 'e.txt', 'f.txt']);
    assert.deepStrictEqual(p.notices(), []);
  });

  test('the file a second add brought is taken once a file is removed to make room', async () => {
    const p = page();
    needs(p);
    const { release, both, extra } = await overlapping(p, ['a.txt', 'b.txt', 'c.txt', 'd.txt']);
    release();
    await both();
    assert.deepStrictEqual(p.notices(), [{ title: 'f.txt', text: SIXTH }], 'refused on the count');
    p.doc.querySelector('#composer-chips .composer-chip-remove').click();
    await pick(p, extra);
    assert.deepStrictEqual(p.chips(), ['b.txt', 'c.txt', 'd.txt', 'e.txt', 'f.txt']);
    assert.deepStrictEqual(p.notices(), []);
  });

  test('Enter pressed while two adds run sends nothing, and once both settle sends the five files the first left', async () => {
    const p = page();
    needs(p);
    const { release, both } = await overlapping(p, ['a.txt', 'b.txt', 'c.txt', 'd.txt']);
    type(p, 'see these');
    pressEnter(p);
    await settled();
    assert.deepStrictEqual(frames(p), [], 'nothing went while the adds ran');
    release();
    await both();
    pressEnter(p);
    await until(() => frames(p).length === 1, 'the chat frame');
    assert.deepStrictEqual(JSON.parse(frames(p)[0]).attachments.map((a) => a.name), ['a.txt', 'b.txt', 'c.txt', 'd.txt', 'e.txt']);
  });

  test('a sixth file the page lets through in error is refused by the server\'s count on Send', async () => {
    const p = page();
    needs(p);
    // The page's detector swapped whole for a copy whose limits take six
    // files, as a count gone wrong would; the composer reads it at each add.
    const sniff = p.w.RundockAttachmentSniff;
    p.w.RundockAttachmentSniff = { ...sniff, LIMITS: { ...sniff.LIMITS, files: 6 } };
    const { release, both } = await overlapping(p, ['a.txt', 'b.txt', 'c.txt', 'd.txt']);
    release();
    await both();
    assert.deepStrictEqual([p.chips().length, p.notices()], [6, []], 'the page let a sixth file through');
    type(p, 'see these');
    pressEnter(p);
    await until(() => frames(p).length === 1, 'the chat frame');
    const workspace = fs.realpathSync(makeTempDir('attach-add-'));
    const sock = new EventEmitter();
    Object.assign(sock, { readyState: 1, sent: [], back: [] });
    sock.send = (raw) => sock.sent.push(JSON.parse(raw));
    sock.on('message', (raw) => sock.back.push(raw));
    const was = config.getWorkspace();
    config.setWorkspace(workspace);
    try {
      createReceiver({ clients: new Set([sock]), findAgent: () => ({ runtime: 'claude' }) }).takes(JSON.parse(frames(p)[0]), sock, true);
      await whenReceived('c1');
    } finally {
      config.setWorkspace(was);
    }
    assert.deepStrictEqual(sock.sent.map((m) => [m.type, m.code]), [['chat_refused', 'too-many-files']]);
    assert.deepStrictEqual(sock.back, [], 'nothing went on to the agent');
    assert.strictEqual(fs.existsSync(path.join(workspace, '.rundock', 'attachments')), false, 'nothing was written');
    p.w.fileSendAnswered(sock.sent[0]);
    assert.deepStrictEqual(p.notices(), [{ title: '6 files not added', text: SIXTH }]);
    assert.deepStrictEqual([p.chips().length, p.$('msg-input').value], [6, 'see these'], 'the files and the text stay');
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

  test('with the composer\'s check made to pass, a HEIC photo is refused by the server\'s check on Send in the words the page gives it on add', async () => {
    const p = page();
    needs(p);
    // The page's detector is swapped for a copy whose checkFile refuses
    // nothing and takes every file for a small PNG, as a detector gone out of
    // step with the server's would. The composer reads the global at each
    // add, so the global is replaced whole: the shipped object is left as it
    // was, and the swap holds whether or not that object is ever frozen.
    p.w.RundockAttachmentSniff = { ...p.w.RundockAttachmentSniff, checkFile: () => ({ type: 'png', width: 2, height: 2 }) };
    await pick(p, p.file('photo.heic', ftyp('heic')));
    assert.deepStrictEqual([p.chips(), p.notices()], [['photo.heic'], []], 'the page let the photo through');
    type(p, 'see this');
    pressEnter(p);
    const frames = () => Array.from(p.w.ws.sent).filter((raw) => raw.startsWith('{"type":"chat"'));
    await until(() => frames().length === 1, 'the chat frame');
    const frame = JSON.parse(frames()[0]);
    // The server, which reads the bytes for itself, takes the message for an
    // agent on Claude.
    const workspace = fs.realpathSync(makeTempDir('attach-add-'));
    const sock = new EventEmitter();
    Object.assign(sock, { readyState: 1, sent: [], back: [] });
    sock.send = (raw) => sock.sent.push(JSON.parse(raw));
    sock.on('message', (raw) => sock.back.push(raw));
    const was = config.getWorkspace();
    config.setWorkspace(workspace);
    try {
      createReceiver({ clients: new Set([sock]), findAgent: () => ({ runtime: 'claude' }) }).takes(frame, sock, true);
      await whenReceived('c1');
    } finally {
      config.setWorkspace(was);
    }
    assert.deepStrictEqual(sock.sent.map((m) => [m.type, m.code]), [['chat_refused', 'heic']]);
    assert.deepStrictEqual(sock.back, [], 'nothing went on to the agent');
    assert.strictEqual(fs.existsSync(path.join(workspace, '.rundock', 'attachments')), false, 'nothing was written');
    // The same photo added to a page whose detector is the shipped one.
    const twin = page();
    await pick(twin, twin.file('photo.heic', ftyp('heic')));
    const onAdd = twin.notices();
    assert.deepStrictEqual([twin.chips(), onAdd.length], [[], 1], 'the shipped page refuses the photo on add');
    p.w.fileSendAnswered(sock.sent[0]);
    assert.deepStrictEqual(p.notices(), onAdd, 'the server\'s refusal shows in the words and title the page gives the photo on add');
    assert.deepStrictEqual([p.chips(), p.$('msg-input').value], [['photo.heic'], 'see this'], 'the photo and the text stay');
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

describe('the composer is drawn as a field holding the chips, the + button and the text', () => {
  const rules = (p) => [...p.doc.styleSheets].flatMap((sheet) => [...sheet.cssRules]).filter((r) => r.selectorText);
  // The declarations of the stylesheet's last rule written for exactly
  // `selector`, for what jsdom does not compute: a var() color, a state.
  function declared(p, selector) {
    const found = rules(p).filter((r) => r.selectorText === selector);
    assert.ok(found.length, `chat.css has a rule for ${selector}`);
    return found[found.length - 1].style;
  }
  // Whether a rule that shows `el` (display: block) matches it as it stands.
  const shownBy = (p, el) => rules(p).filter((r) => r.style.display === 'block')
    .filter((r) => r.selectorText.split(',').some((s) => el.matches(s.trim())));
  async function refused(p) {
    await pick(p, p.file('bundle.zip', ZIP));
    assert.strictEqual(p.doc.querySelectorAll('#composer-notice .composer-notice-item').length, 1, 'a message shows');
  }

  test('the field holds the chips and the row, and Send and the messages sit outside it', () => {
    const p = page();
    const bar = p.doc.querySelector('.chat-input');
    const field = bar.querySelector(':scope > div.composer-field');
    assert.ok(field, 'the composer holds a field');
    assert.deepStrictEqual([...field.children].map((el) => el.id || el.className), ['composer-chips', 'composer-row']);
    const row = field.querySelector(':scope > div.composer-row');
    assert.deepStrictEqual([...row.children].map((el) => el.id || el.className), ['attach-btn', 'attach-input', 'msg-input', 'mic-slot']);
    assert.strictEqual(row.querySelector('.mic-slot').getAttribute('aria-hidden'), 'true');
    assert.strictEqual(p.$('send-btn').parentElement, bar, 'Send sits beside the field');
    assert.strictEqual(p.$('composer-notice').parentElement, bar, 'the messages sit under it');
    const layout = p.w.getComputedStyle(bar);
    assert.deepStrictEqual([layout.alignItems, layout.flexWrap, layout.rowGap], ['flex-end', 'wrap', '8px']);
    assert.strictEqual(declared(p, '.composer-field').background, 'var(--card)');
    assert.strictEqual(p.w.getComputedStyle(p.$('msg-input')).backgroundColor, 'rgba(0, 0, 0, 0)', 'the text is transparent');
    assert.strictEqual(declared(p, '.composer-field:focus-within').boxShadow, '0 0 0 1px var(--text-2)');
    assert.ok(!rules(p).some((r) => /textarea:focus\b/.test(r.selectorText) && r.style.boxShadow), 'the ring left the text');
  });

  test('the + button\'s tooltip says Attach files, is a tooltip and shows on keyboard focus and on hover', () => {
    const p = page();
    const button = p.$('attach-btn');
    const tip = button.querySelector('span.att-tip');
    assert.ok(tip, 'the + button holds its tooltip');
    assert.strictEqual(tip.getAttribute('role'), 'tooltip');
    assert.strictEqual(tip.textContent, 'Attach files');
    assert.strictEqual(button.getAttribute('aria-label'), 'Attach files');
    assert.strictEqual(button.getAttribute('title'), null);
    assert.strictEqual(p.w.getComputedStyle(tip).display, 'none', 'hidden at rest');
    assert.deepStrictEqual(shownBy(p, tip), [], 'no rule shows it at rest');
    button.focus();
    assert.strictEqual(shownBy(p, tip).length, 1, 'a rule shows it on keyboard focus');
    assert.ok(shownBy(p, tip)[0].selectorText.split(',').map((s) => s.trim()).includes('.attach-btn:hover .att-tip'), 'and on hover');
    const look = declared(p, '.att-tip');
    assert.deepStrictEqual([look.color, look.background], ['var(--text-1)', 'var(--surface)']);
  });

  test('the + button is 32 by 32 px and its focus ring sits 1px off it', () => {
    const p = page();
    const size = p.w.getComputedStyle(p.$('attach-btn'));
    assert.deepStrictEqual([size.width, size.height], ['32px', '32px']);
    assert.strictEqual(declared(p, '.attach-btn').color, 'var(--text-2-strong)');
    const hover = declared(p, '.attach-btn:hover');
    assert.deepStrictEqual([hover.color, hover.background], ['var(--text-1)', 'var(--elevated)']);
    const ring = declared(p, '.attach-btn:focus-visible');
    assert.deepStrictEqual([ring.outline, ring.outlineOffset], ['2px solid var(--accent-control)', '1px']);
  });

  test('a chip is 52px high, on --elevated with a 1px --border edge, and titled with its file\'s name', async () => {
    const p = page();
    await pick(p, p.file('report.pdf'));
    const chip = p.doc.querySelector('#composer-chips .composer-chip');
    assert.strictEqual(p.w.getComputedStyle(chip).height, '52px');
    assert.strictEqual(chip.getAttribute('title'), 'report.pdf');
    const look = declared(p, '.composer-chip');
    assert.deepStrictEqual([look.background, look.border], ['var(--elevated)', '1px solid var(--border)']);
    assert.strictEqual(declared(p, '.composer-chip-name').color, 'var(--text-1)');
    assert.strictEqual(declared(p, '.composer-chip-meta').color, 'var(--text-2-strong)');
    const remove = p.w.getComputedStyle(chip.querySelector('.composer-chip-remove'));
    assert.deepStrictEqual([remove.width, remove.height, remove.color], ['24px', '24px', 'var(--text-2-strong)']);
    const hover = declared(p, '.composer-chip-remove:hover');
    assert.deepStrictEqual([hover.color, hover.background], ['var(--text-1)', 'var(--card)']);
    assert.strictEqual(declared(p, '.composer-chip-remove:focus-visible').outlineOffset, '0px');
  });

  test('a chip\'s tile is 40px on --card, holding its type\'s icon in --text-2-strong', async () => {
    const p = page();
    await pick(p, p.file('shot.png'), p.file('report.pdf'), p.file('table.csv'));
    const tiles = [...p.doc.querySelectorAll('#composer-chips .composer-chip > span.composer-chip-tile')];
    assert.strictEqual(tiles.length, 3, 'each chip leads with a tile');
    const size = p.w.getComputedStyle(tiles[0]);
    assert.deepStrictEqual([size.width, size.height, size.color], ['40px', '40px', 'var(--text-2-strong)']);
    assert.strictEqual(declared(p, '.composer-chip-tile').background, 'var(--card)');
    const icons = tiles.map((tile) => tile.querySelector('svg'));
    assert.ok(icons.every(Boolean), 'each tile holds an icon');
    assert.strictEqual(new Set(icons.map((svg) => svg.innerHTML)).size, 3, 'an image, a PDF and a CSV each have their own icon');
  });

  test('the messages are a column 6px apart, 54px short of the right edge, each on --surface', async () => {
    const p = page();
    await refused(p);
    const column = p.w.getComputedStyle(p.$('composer-notice'));
    assert.deepStrictEqual([column.display, column.flexDirection, column.gap, column.marginRight], ['flex', 'column', '6px', '54px']);
    const item = declared(p, '.composer-notice-item');
    assert.deepStrictEqual([item.background, item.border], ['var(--surface)', '1px solid var(--border)']);
    const title = declared(p, '.composer-notice-title');
    assert.deepStrictEqual([title.color, title.fontWeight], ['var(--text-1)', '600']);
    assert.strictEqual(declared(p, '.composer-notice-text').color, 'var(--text-2-strong)');
    assert.strictEqual(declared(p, '.composer-notice-icon').color, 'var(--attention-text)');
  });
});

describe('files dropped over the conversation land in the composer, and nothing dropped elsewhere opens in the page', () => {
  const Kanban = require('../../public/kanban.js');
  const BOARD = '---\n\nkanban-plugin: board\n\n---\n\n## To do\n\n- [ ] one\n- [ ] two\n\n## Done\n\n';
  const settled = () => new Promise((resolve) => setTimeout(resolve, 20));
  const field = (p) => p.doc.querySelector('#view-chat .composer-field');
  const marked = (p) => field(p).classList.contains('drop');


  test('a drag of files over the messages marks the field and prevents dragover', () => {
    const p = page();
    needs(p);
    const files = [p.file('a.txt')];
    const enter = drag(p, p.$('messages'), 'dragenter', { files });
    const over = drag(p, p.$('messages'), 'dragover', { files });
    assert.deepStrictEqual([enter.defaultPrevented, over.defaultPrevented], [true, true]);
    assert.ok(marked(p), 'the field is marked');
    assert.deepStrictEqual(p.chips(), [], 'a drag adds nothing');
  });

  test('the cover holds the two lines', () => {
    const p = page();
    needs(p);
    for (const type of ['dragenter', 'dragover', 'dragover']) drag(p, p.$('messages'), type, { files: [p.file('a.txt')] });
    const covers = field(p).querySelectorAll(':scope > div.composer-drop-cover');
    assert.strictEqual(covers.length, 1, 'the marked field shows one cover');
    const message = covers[0].querySelector(':scope > div.composer-drop-msg');
    assert.ok(message, 'holding the message');
    assert.deepStrictEqual([...message.children].map((el) => el.tagName.toLowerCase()), ['svg', 'b', 'span']);
    assert.strictEqual(message.querySelector('b').textContent, 'Drop to attach');
    assert.strictEqual(message.querySelector('span').textContent, 'Images, PDF, text, Markdown or CSV');
    // Drawn over the field's content, with a ring inside its edge, so the
    // field keeps its width and height.
    assert.strictEqual(p.w.getComputedStyle(field(p)).position, 'relative');
    assert.strictEqual(p.w.getComputedStyle(covers[0]).position, 'absolute');
    const own = [...p.doc.styleSheets].flatMap((sheet) => [...sheet.cssRules]).filter((r) => r.selectorText === '.composer-field.drop');
    assert.ok(own.length, 'chat.css has a rule for the marked field');
    const ring = own[own.length - 1].style;
    assert.deepStrictEqual([ring.outline, ring.outlineOffset], ['1.5px dashed var(--accent-control)', '-1.5px']);
    for (const prop of ['width', 'height', 'padding', 'border', 'margin']) {
      assert.ok(own.every((r) => !r.style.getPropertyValue(prop)), `marking sets no ${prop}`);
    }
  });

  test('a drop over the messages adds the files', async () => {
    const p = page();
    needs(p);
    const capture = new p.w.File([typed('image.png', 10)], 'image.png', { type: 'image/png' });
    const event = await dropped(p, p.$('messages'), [p.file('a.txt'), capture], 2);
    assert.strictEqual(event.defaultPrevented, true);
    assert.deepStrictEqual(p.chips(), ['a.txt', 'image.png'], 'a dropped image keeps its name');
    assert.ok(!marked(p), 'the drop clears the mark');
    assert.strictEqual(field(p).querySelector('.composer-drop-cover'), null);
  });

  test('a drop over the composer adds them', async () => {
    const p = page();
    needs(p);
    const event = await dropped(p, p.$('msg-input'), [p.file('notes.md'), p.file('report.pdf')], 2);
    assert.strictEqual(event.defaultPrevented, true);
    assert.deepStrictEqual(p.chips(), ['notes.md', 'report.pdf']);
    assert.ok(!marked(p));
  });

  test('a dragleave to outside the view clears the mark', () => {
    const p = page();
    needs(p);
    const files = [p.file('a.txt')];
    drag(p, p.$('messages'), 'dragover', { files });
    drag(p, p.$('messages'), 'dragleave', { files, relatedTarget: p.$('msg-input') });
    assert.ok(marked(p), 'a move within the view keeps it');
    drag(p, p.$('messages'), 'dragleave', { files, relatedTarget: p.$('sidebar') });
    assert.ok(!marked(p), 'a move to the sidebar clears it');
    drag(p, p.$('messages'), 'dragover', { files });
    drag(p, p.$('messages'), 'dragleave', { files, relatedTarget: null });
    assert.ok(!marked(p), 'a move out of the window clears it');
    drag(p, p.$('messages'), 'dragover', { files });
    drag(p, p.doc.body, 'dragend', { files });
    assert.ok(!marked(p), 'and so does the drag ending');
    assert.strictEqual(field(p).querySelector('.composer-drop-cover'), null);
  });

  // As on the base, so it needs nothing the base lacks.
  test('a drag of text alone is neither marked nor prevented', async () => {
    const p = page();
    const events = ['dragenter', 'dragover', 'drop'].map((type) => drag(p, p.$('msg-input'), type, { types: ['text/plain'] }));
    assert.deepStrictEqual(events.map((e) => e.defaultPrevented), [false, false, false]);
    assert.strictEqual(p.doc.querySelector('.drop'), null, 'nothing is marked');
    await settled();
    assert.deepStrictEqual(p.chips(), []);
  });

  test('a drag of files while a send waits marks nothing and adds nothing', async () => {
    const p = page();
    needs(p);
    await pick(p, p.file('a.txt'));
    type(p, 'see this');
    pressEnter(p);
    assert.strictEqual(p.w.sendWaiting('c1'), true, 'the send waits');
    const files = [p.file('b.txt')];
    const enter = drag(p, p.$('messages'), 'dragenter', { files });
    drag(p, p.$('messages'), 'dragover', { files });
    assert.strictEqual(enter.defaultPrevented, false, 'the view takes no drag');
    assert.ok(!marked(p), 'the field is not marked');
    const drop = drag(p, p.$('messages'), 'drop', { files });
    assert.strictEqual(drop.defaultPrevented, true, 'the file still opens nothing');
    await settled();
    assert.deepStrictEqual(p.chips(), ['a.txt']);
  });

  test('a drop of files on the sidebar is prevented and adds nothing', async () => {
    const p = page();
    needs(p);
    const files = [p.file('a.txt')];
    // A handler inside the page sees the drag before the window does.
    const seen = [];
    p.$('sidebar').addEventListener('drop', (e) => seen.push(e.defaultPrevented));
    const over = drag(p, p.$('sidebar'), 'dragover', { files });
    const drop = drag(p, p.$('sidebar'), 'drop', { files });
    assert.deepStrictEqual([over.defaultPrevented, drop.defaultPrevented], [true, true]);
    assert.deepStrictEqual(seen, [false], 'the window acts after the page\'s own handlers');
    assert.ok(!marked(p));
    await settled();
    assert.deepStrictEqual(p.chips(), []);
  });

  test('a drop of 6 files refused whole', async () => {
    const p = page();
    needs(p);
    const files = ['a', 'b', 'c', 'd', 'e', 'f'].map((n) => p.file(`${n}.txt`));
    drag(p, p.$('messages'), 'dragover', { files });
    drag(p, p.$('messages'), 'drop', { files });
    await until(() => p.notices().length === 1, 'the message');
    assert.deepStrictEqual(p.chips(), []);
    assert.deepStrictEqual(p.notices(), [{ title: '6 files not added', text: 'That would make 6 files; the limit is 5 per message' }]);
  });

  test('a drag of files on the board leaves its own handlers\' results as on the base', async () => {
    const p = page();
    needs(p);
    const { mountBoardView } = await import('../../public/viewers/board-view.js');
    let changes = 0;
    const board = mountBoardView({ paneElement: p.$('board'), path: 'b.md', content: BOARD, onWikilink() {}, onChange: () => { changes += 1; } }, Kanban);
    const before = board.getContentForSave();
    const cards = () => [...p.$('board').querySelectorAll('.board-card')];
    const markers = () => p.$('board').querySelectorAll('.insert-before, .insert-after, .insert-end').length;

    // A file dragged over a card and dropped on it: the board takes nothing.
    const files = [p.file('a.txt')];
    const [one, two] = cards();
    const over = drag(p, two, 'dragover', { files });
    assert.strictEqual(markers(), 0, 'the board marks no gap');
    const drop = drag(p, two, 'drop', { files });
    assert.deepStrictEqual([board.getContentForSave(), changes], [before, 0], 'the board is unchanged');
    assert.deepStrictEqual([over.defaultPrevented, drop.defaultPrevented], [true, true], 'and the file opens nothing');
    assert.ok(!marked(p), 'the field is not marked');

    // A card dragged below the next still moves, with the board's own marks.
    const frame = globalThis.requestAnimationFrame;
    globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
    try {
      drag(p, one, 'dragstart', { types: [] });
      const cardOver = drag(p, two, 'dragover');
      assert.ok(two.classList.contains('insert-after'), 'the board marks the gap below');
      assert.ok(!marked(p), 'the field is not marked');
      const cardDrop = drag(p, two, 'drop');
      drag(p, one, 'dragend');
      await settled();
      assert.deepStrictEqual([cardOver.defaultPrevented, cardDrop.defaultPrevented], [true, true]);
    } finally {
      if (frame) globalThis.requestAnimationFrame = frame; else delete globalThis.requestAnimationFrame;
    }
    const after = board.getContentForSave();
    assert.ok(after.indexOf('- [ ] two') < after.indexOf('- [ ] one'), 'the card moved');
    assert.strictEqual(changes, 1);
    assert.strictEqual(markers(), 0);
    assert.deepStrictEqual(p.chips(), []);
    board.destroy();
  });
});

describe('a PDF held for an agent on Codex holds Send until it goes', () => {
  const CODEX_PDF = 'This agent runs on Codex, which can\'t read PDFs yet. Attach a screenshot of the page or paste the text.';
  const HELD = { disabled: true, active: false };
  const LIT = { disabled: false, active: true };
  const sendState = (p) => ({ disabled: p.$('send-btn').disabled, active: p.$('send-btn').classList.contains('active') });
  const warned = (p) => [...p.doc.querySelectorAll('#composer-chips .composer-chip.warn')].map((c) => c.querySelector('.composer-chip-name').textContent);
  const frames = (p) => Array.from(p.w.ws.sent).filter((raw) => raw.startsWith('{"type":"chat"'));
  const removeNamed = (p, name) => p.doc.querySelector(`#composer-chips .composer-chip-remove[aria-label="Remove ${name}"]`).click();
  const settled = () => new Promise((resolve) => setTimeout(resolve, 20));

  // The conversation handed to another agent, through the shipped header
  // effect cut out of public/app.js, as a delegation hands it.
  function handTo(p, agentId) {
    if (!p.w.__effects) {
      p.w.eval(`var __effects = {${between(APP, "'update-chat-header': (convoId, ef) => {", "\n  'start-streaming-bubble'", 'the delegation header effect')}}`);
    }
    const convoId = p.w.activeConversation.id;
    p.w.getConvoState(convoId).activeAgentId = agentId;
    p.w.__effects['update-chat-header'](convoId, { toAgentId: agentId });
  }

  test('a PDF added in a Codex conversation is held, outlined and explained', async () => {
    const p = page({ agentId: 'coder' });
    needs(p, 'sendHeld');
    await pick(p, p.file('report.pdf'));
    assert.deepStrictEqual(p.chips(), ['report.pdf'], 'the PDF stays');
    assert.deepStrictEqual(warned(p), ['report.pdf'], 'its chip is edged');
    assert.deepStrictEqual(p.notices(), [{ title: 'report.pdf', text: CODEX_PDF }]);
    assert.strictEqual(p.w.sendHeld('c1'), true);
  });

  test('Send is disabled and not ready', async () => {
    const p = page({ agentId: 'coder' });
    needs(p, 'sendHeld');
    await pick(p, p.file('report.pdf'));
    type(p, 'summarise this');
    assert.deepStrictEqual(sendState(p), HELD);
    assert.strictEqual(p.w.sendReady('summarise this'), false);
  });

  test('Enter sends nothing', async () => {
    const p = page({ agentId: 'coder' });
    needs(p, 'sendHeld');
    await pick(p, p.file('report.pdf'));
    type(p, 'summarise this');
    pressEnter(p);
    p.$('send-btn').click();
    p.w.sendMessage();
    await settled();
    assert.deepStrictEqual(frames(p), [], 'no message went');
    assert.strictEqual(p.w.sendWaiting('c1'), false);
    assert.deepStrictEqual([p.chips(), p.$('msg-input').value], [['report.pdf'], 'summarise this'], 'the PDF and the text stay');
  });

  test('Send stays disabled after endWait, after finishProcessing and after the conversation is shown again', async () => {
    const p = page();
    needs(p, 'sendHeld');
    await pick(p, p.file('report.pdf'));
    type(p, 'summarise this');
    pressEnter(p);
    assert.strictEqual(p.w.sendWaiting('c1'), true, 'the send waits');
    // Handed to an agent on Codex while the send waits, which the server
    // then refuses.
    handTo(p, 'coder');
    p.w.fileSendAnswered({ type: 'chat_refused', conversationId: 'c1', code: 'codex-pdf', title: 'report.pdf', name: 'report.pdf', text: CODEX_PDF });
    assert.strictEqual(p.w.sendWaiting('c1'), false, 'the wait ended');
    assert.deepStrictEqual(sendState(p), HELD, 'after endWait');
    p.w.startProcessing('c1');
    assert.ok(p.$('send-btn').classList.contains('cancel'), 'Send is the Stop button while the agent works');
    p.w.finishProcessing('c1');
    assert.deepStrictEqual(sendState(p), HELD, 'after finishProcessing');
    p.open('c2', 'lead');
    assert.strictEqual(p.$('send-btn').disabled, false, 'another conversation holds nothing');
    // What opening a conversation reaches in the rest of the window.
    p.w.eval(`function closeFindBar() {} function persistLastActiveConversation() {} var pendingMessageAnchor = null;
      var RundockPermissions = { holdsOpenRequest: () => false }; var pendingPermissionsByConvo = new Map(); unread.clearConvo = () => {};`);
    p.w.openConversation('c1');
    assert.deepStrictEqual(p.chips(), ['report.pdf']);
    assert.deepStrictEqual(sendState(p), HELD, 'after the conversation is shown again');
  });

  test('the PDF removed lights Send', async () => {
    const p = page({ agentId: 'coder' });
    needs(p, 'sendHeld');
    await pick(p, p.file('report.pdf'), p.file('notes.txt'));
    type(p, 'summarise this');
    assert.deepStrictEqual(sendState(p), HELD);
    removeNamed(p, 'report.pdf');
    assert.deepStrictEqual([p.chips(), p.notices()], [['notes.txt'], []]);
    assert.strictEqual(p.w.sendHeld('c1'), false);
    assert.deepStrictEqual(sendState(p), LIT);
  });

  test('the agent changed away from Codex lights Send and removes the message', async () => {
    const p = page({ agentId: 'coder' });
    needs(p, 'sendHeld');
    await pick(p, p.file('report.pdf'), p.file('photo.heic', ftyp('heic')));
    type(p, 'summarise this');
    assert.deepStrictEqual(p.notices(), [{ title: 'photo.heic', text: HEIC }, { title: 'report.pdf', text: CODEX_PDF }]);
    // An agent with no runtime named runs on Claude.
    handTo(p, 'helper');
    assert.deepStrictEqual(p.notices(), [{ title: 'photo.heic', text: HEIC }], 'the other message stays');
    assert.deepStrictEqual([p.chips(), warned(p)], [['report.pdf'], []]);
    assert.strictEqual(p.w.sendHeld('c1'), false);
    assert.deepStrictEqual(sendState(p), LIT);
  });

  test('a PDF held when the agent changes to Codex is held', async () => {
    const p = page();
    needs(p, 'sendHeld');
    await pick(p, p.file('report.pdf'));
    type(p, 'summarise this');
    assert.deepStrictEqual([p.notices(), sendState(p)], [[], LIT], 'an agent on Claude takes it');
    handTo(p, 'coder');
    assert.deepStrictEqual([p.chips(), warned(p)], [['report.pdf'], ['report.pdf']]);
    assert.deepStrictEqual(p.notices(), [{ title: 'report.pdf', text: CODEX_PDF }]);
    assert.deepStrictEqual(sendState(p), HELD);
    // Back, and to Codex again: held again, with one message.
    handTo(p, 'lead');
    assert.deepStrictEqual([warned(p), p.notices(), sendState(p)], [[], [], LIT]);
    handTo(p, 'coder');
    assert.deepStrictEqual(warned(p), ['report.pdf']);
    assert.deepStrictEqual(p.notices(), [{ title: 'report.pdf', text: CODEX_PDF }]);
    assert.deepStrictEqual(sendState(p), HELD);
  });

  test('two PDFs give two messages', async () => {
    const p = page({ agentId: 'coder' });
    needs(p, 'sendHeld');
    await pick(p, p.file('a.pdf'), p.file('b.pdf'));
    const two = [{ title: 'a.pdf', text: CODEX_PDF }, { title: 'b.pdf', text: CODEX_PDF }];
    assert.deepStrictEqual([p.notices(), warned(p)], [two, ['a.pdf', 'b.pdf']]);
    // The same two when the hold begins on a change of agent.
    handTo(p, 'lead');
    handTo(p, 'coder');
    assert.deepStrictEqual([p.notices(), warned(p)], [two, ['a.pdf', 'b.pdf']]);
  });

  test('a Dismiss leaves Send disabled', async () => {
    const p = page({ agentId: 'coder' });
    needs(p, 'sendHeld');
    await pick(p, p.file('report.pdf'));
    type(p, 'summarise this');
    p.doc.querySelector('#composer-notice .composer-notice-dismiss').click();
    assert.deepStrictEqual(p.notices(), []);
    assert.deepStrictEqual([warned(p), sendState(p)], [['report.pdf'], HELD]);
    // Evaluated again with the agent unchanged, the message stays dismissed.
    p.w.refreshAttachButton(p.w.activeConversation);
    assert.deepStrictEqual([p.notices(), sendState(p)], [[], HELD]);
    assert.strictEqual(p.w.sendHeld('c1'), true);
  });

  test('a PNG in a Codex conversation and a PDF in another conversation are added and light Send', async () => {
    const p = page({ agentId: 'coder' });
    await pick(p, p.file('a.png'));
    type(p, 'see this');
    assert.deepStrictEqual([p.chips(), p.notices(), warned(p)], [['a.png'], [], []]);
    assert.deepStrictEqual(sendState(p), LIT);
    p.open('c2', 'lead');
    await pick(p, p.file('report.pdf'));
    type(p, 'summarise this');
    assert.deepStrictEqual([p.chips(), p.notices(), warned(p)], [['report.pdf'], [], []]);
    assert.deepStrictEqual(sendState(p), LIT);
  });

  test('with the composer\'s check made to pass, the server\'s codex-pdf refusal comes back with the same wording', async () => {
    const p = page({ agentId: 'coder' });
    needs(p, 'sendHeld');
    // The page's list says the agent runs on Claude, as a list gone stale
    // would, so the composer holds nothing back.
    p.w.eval("agents.find((a) => a.id === 'coder').runtime = 'claude';");
    await pick(p, p.file('report.pdf'));
    assert.deepStrictEqual([p.notices(), p.w.sendHeld('c1')], [[], false]);
    type(p, 'summarise this');
    pressEnter(p);
    await until(() => frames(p).length === 1, 'the chat frame');
    const frame = JSON.parse(frames(p)[0]);
    assert.strictEqual(frame.agent, 'coder');
    // The server, which knows the agent runs on Codex, takes the message.
    const workspace = fs.realpathSync(makeTempDir('attach-add-'));
    const sock = new EventEmitter();
    Object.assign(sock, { readyState: 1, sent: [], back: [] });
    sock.send = (raw) => sock.sent.push(JSON.parse(raw));
    sock.on('message', (raw) => sock.back.push(raw));
    const was = config.getWorkspace();
    config.setWorkspace(workspace);
    try {
      createReceiver({ clients: new Set([sock]), findAgent: () => ({ runtime: 'codex' }) }).takes(frame, sock, true);
      await whenReceived('c1');
    } finally {
      config.setWorkspace(was);
    }
    assert.deepStrictEqual(sock.sent.map((m) => [m.type, m.code]), [['chat_refused', 'codex-pdf']]);
    assert.deepStrictEqual(sock.back, [], 'nothing went on to the agent');
    assert.strictEqual(fs.existsSync(path.join(workspace, '.rundock', 'attachments')), false, 'nothing was written');
    p.w.fileSendAnswered(sock.sent[0]);
    assert.deepStrictEqual(p.notices(), [{ title: 'report.pdf', text: CODEX_PDF }], 'the page\'s own words for a held PDF');
    assert.deepStrictEqual([p.chips(), p.$('msg-input').value], [['report.pdf'], 'summarise this'], 'the PDF and the text stay');
  });
});

describe('a file\'s name is shown as text', () => {
  const NAME = '<img src=x onerror=alert(1)>.png';
  const CODEX_PDF = 'This agent runs on Codex, which can\'t read PDFs yet. Attach a screenshot of the page or paste the text.';
  // Every element under the composer, by tag and class: the same for a file
  // named as markup as for one with a plain name, so the name drew nothing.
  const shape = (p) => [...p.doc.querySelectorAll('#view-chat .chat-input *')].map((e) => `${e.tagName.toLowerCase()}.${e.getAttribute('class') || ''}`);
  const chip = (p, name) => [...p.doc.querySelectorAll('#composer-chips .composer-chip')]
    .find((c) => c.querySelector('.composer-chip-name').textContent === name);
  function shownAsText(p, twin) {
    const named = chip(p, NAME);
    assert.ok(named, 'a chip shows the name as written');
    assert.strictEqual(named.getAttribute('title'), NAME);
    assert.strictEqual(named.querySelector('.composer-chip-remove').getAttribute('aria-label'), `Remove ${NAME}`);
    assert.strictEqual(p.doc.querySelectorAll('img, [onerror]').length, 0, 'no element from the name');
    assert.deepStrictEqual(shape(p), shape(twin), 'the composer holds what the draw made and nothing else');
  }

  test('a file named as markup and picked shows as its name in the chip, its title and its remove button', async () => {
    const p = page();
    needs(p);
    await pick(p, p.file(NAME));
    const twin = page();
    await pick(twin, twin.file('plain.png'));
    shownAsText(p, twin);
  });

  test('a file named as markup and pasted shows as its name in the chip, its title and its remove button', async () => {
    // A pasted image takes the name "Pasted image", so the name is carried by
    // a PDF, which keeps its own.
    const p = page();
    needs(p);
    paste(p, [p.file(NAME), p.file(NAME, pdf())]);
    await until(() => p.chips().length === 2, '2 chips');
    assert.deepStrictEqual(p.chips(), ['Pasted image', NAME]);
    const twin = page();
    paste(twin, [twin.file('plain.png'), twin.file('plain.png', pdf())]);
    await until(() => twin.chips().length === 2, '2 chips');
    shownAsText(p, twin);
  });

  test('a file named as markup and dropped shows as its name in the chip, its title and its remove button', async () => {
    const p = page();
    needs(p);
    await dropped(p, p.$('messages'), [p.file(NAME)], 1);
    const twin = page();
    await dropped(twin, twin.$('messages'), [twin.file('plain.png')], 1);
    shownAsText(p, twin);
  });

  test('a message refusing a file named as markup shows the name as its title', async () => {
    const p = page();
    needs(p);
    await pick(p, p.file(NAME, ftyp('heic')));
    assert.deepStrictEqual(p.notices(), [{ title: NAME, text: HEIC }]);
    const twin = page();
    await pick(twin, twin.file('plain.png', ftyp('heic')));
    assert.strictEqual(p.doc.querySelectorAll('img, [onerror]').length, 0, 'no element from the name');
    assert.deepStrictEqual(shape(p), shape(twin));
  });

  test('a codex-pdf message for a PDF named as markup shows the name as its title', async () => {
    const p = page({ agentId: 'coder' });
    needs(p, 'sendHeld');
    await pick(p, p.file(NAME, pdf()));
    assert.deepStrictEqual(p.notices(), [{ title: NAME, text: CODEX_PDF }]);
    const twin = page({ agentId: 'coder' });
    await pick(twin, twin.file('plain.png', pdf()));
    shownAsText(p, twin);
  });
});
