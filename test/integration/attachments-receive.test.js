'use strict';
// Integration: a chat message's attachments through the real server.
//
// A message with files is stored once, with its record entry, before it goes
// any further, and from there it carries the stored text, never the file data:
// into the transcript row, the runtime's prompt, the runtime's own session
// file and the history a reload reads. A refused message is answered with one
// chat_refused and writes, records, appends and dispatches nothing. Files for
// a Codex agent are refused before anything is decoded. A frame over the limit
// closes only its own socket.
//
// Every wait is h.waitUntil, which returns false on timeout, followed by an
// assertion, so a server that ignores attachments fails here on an assertion.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const h = require('../helpers/harness.js');
const store = require('../../lib/attachments/store.js');
const { agentFile, standardTeam } = require('../helpers/workspace.js');

// The receive is async and the handler ignores its promise, so a rejection it
// failed to catch would surface only here.
const rejections = [];
process.on('unhandledRejection', (reason) => { rejections.push(reason); });

let client;
before(async () => {
  await h.boot({
    agents: {
      ...standardTeam(),
      researcher: agentFile({
        name: 'researcher', displayName: 'Ida', role: 'Researcher',
        description: 'Researches suppliers', type: 'specialist', order: 5,
        reportsTo: 'chief-of-staff', runtime: 'codex',
        body: 'You are Ida, the researcher.',
      }),
    },
  });
  client = await h.connect();
});
after(async () => h.shutdown());

const NOT_SENT = 'Message not sent';
const FALLBACK = 'Rundock couldn\'t save the files. Your message and files are still here.';

// The first message after `since` on `on` that matches, once one arrives.
async function arrived(pred, { since = 0, on = client, timeout = 8000 } = {}) {
  await h.waitUntil(() => on.messages.slice(since).some(pred), { timeout });
  return on.messages.slice(since).find(pred);
}

// A frame of exactly `bytes` UTF-8 bytes: a message of `type` padded out.
function padded(type, bytes) {
  const base = Buffer.byteLength(JSON.stringify({ type, pad: '' }));
  const frame = JSON.stringify({ type, pad: 'x'.repeat(bytes - base) });
  assert.strictEqual(Buffer.byteLength(frame), bytes);
  return frame;
}

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const file = (name, bytes) => ({ name, data: bytes.toString('base64') });
const decoded = (sent) => Buffer.from(sent.data, 'base64');
function png(width = 640, height = 480, size = 33) {
  const b = Buffer.alloc(size);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'latin1');
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
}
function pdf(size = 40) {
  const b = Buffer.alloc(size, 0x20);
  b.write('%PDF-1.7\n', 0, 'latin1');
  return b;
}

const attachmentsDir = () => path.join(h.workspaceDir, '.rundock', 'attachments');
const folderOf = (id) => path.join(attachmentsDir(), id);
const listing = (dir) => { try { return fs.readdirSync(dir).sort(); } catch (e) { return null; } };
// Each file in `dir` by name, with its bytes; null when there is no folder.
const bytesIn = (dir) => { const names = listing(dir); return names && Object.fromEntries(names.map((n) => [n, fs.readFileSync(path.join(dir, n))])); };
const rows = (id) => h.internal.convoTranscripts.get(id) || h.internal.loadTranscript(id) || [];
const userRows = (id) => rows(id).filter((r) => r.role === 'user');
const entriesOf = (id) => { try { return store.readRecord(h.workspaceDir, id).messages; } catch (e) { return null; } };
const promptsWith = (tag) => h.readPrompts().map((p) => p.prompt).filter((p) => p.includes(tag));
// The stored name a line gives: what follows its last slash, up to its label.
const nameIn = (line) => line.slice(line.lastIndexOf('/') + 1, line.indexOf(' ('));

function scenario(rules) {
  fs.writeFileSync(path.join(h.workspaceDir, 'stub-scenario.json'), JSON.stringify({ rules }));
}
// Each tag answered `DONE-<tag>`; `keepSession` keeps each turn's session
// file as a chat run keeps it.
const answers = (tags, extra = {}) => scenario(tags.map((tag) => ({ match: { promptIncludes: tag }, turn: [{ text: `DONE-${tag}` }], ...extra })));

function chat(id, content, attachments, extra = {}) {
  const msg = { type: 'chat', conversationId: id, agent: 'chief-of-staff', content, ...extra };
  if (attachments !== undefined) msg.attachments = attachments;
  client.send(msg);
}
const storedFor = (id, since, timeout) => arrived((m) => m.type === 'chat_stored' && m.conversationId === id, { since, timeout });
const resultFor = (id, text, since) => arrived((m) => m.type === 'result' && m._conversationId === id && String(m.result || '').includes(text), { since, timeout: 15000 });

// The messages the server sends back into its own handler (strings, unlike a
// page's frames), on every server socket, until `stop`.
function recordReentries() {
  const seen = [];
  const sockets = [...h.internal.connectedClients];
  for (const sock of sockets) {
    const emit = sock.emit;
    sock.emit = function (event, data, ...rest) {
      if (event === 'message' && typeof data === 'string') seen.push(JSON.parse(data));
      return emit.call(this, event, data, ...rest);
    };
  }
  return { seen, stop: () => { for (const sock of sockets) delete sock.emit; } };
}

// One record entry, one stored copy of each file and one transcript row for
// each message `stored` names (their chat_stored answers), in order.
function writtenOnce(id, stored) {
  assert.deepStrictEqual(entriesOf(id), stored.map((s) => s.entry), 'one record entry per message');
  const names = stored.flatMap((s) => s.entry.files.map((f) => f.file));
  assert.deepStrictEqual(listing(folderOf(id)), [...names, 'record.json'].sort(), 'one stored copy of each file');
  assert.deepStrictEqual(userRows(id).map((r) => r.text), stored.map((s) => s.content), 'one transcript row per message');
}

// Sends `msg` and returns its chat_refused, once the message has had time to
// do anything else; it must have written, appended and dispatched nothing.
async function refusedWith(msg, { code, title, text }) {
  const id = msg.conversationId;
  const at = id || 'default';
  const was = {
    spawns: h.readInvocations().length, prompts: h.promptsFor(msg.agent).length,
    turns: h.codexTurnPrompts().length, rows: rows(at).length,
  };
  const folder = listing(folderOf(at));
  const bytes = bytesIn(folderOf(at));
  const record = id ? entriesOf(id) : null;
  const since = client.messages.length;
  client.send(msg);
  const got = await arrived((m) => m.type === 'chat_refused', { since });
  assert.ok(got, 'the message is answered with chat_refused');
  await h.delay(300);
  const answered = client.messages.slice(since);
  assert.strictEqual(answered.filter((m) => m.type === 'chat_refused').length, 1, 'exactly one chat_refused');
  assert.ok(!answered.some((m) => m.type === 'chat_stored'), 'and no chat_stored');
  assert.deepStrictEqual({ code: got.code, title: got.title, text: got.text }, { code, title, text });
  assert.strictEqual(got.conversationId, id);
  assert.strictEqual(rows(at).length, was.rows, 'no transcript row');
  assert.strictEqual(h.readInvocations().length, was.spawns, 'no process spawned');
  assert.strictEqual(h.promptsFor(msg.agent).length, was.prompts, 'nothing written to a stdin');
  assert.strictEqual(h.codexTurnPrompts().length, was.turns, 'no Codex turn');
  assert.deepStrictEqual(listing(folderOf(at)), folder, 'the attachments folder as it was');
  assert.deepStrictEqual(bytesIn(folderOf(at)), bytes, 'every file already there holds the bytes it held');
  if (id) assert.deepStrictEqual(entriesOf(id), record, 'no record entry');
  return got;
}

// First in the file: nothing before it has written under .rundock.
describe('files for a Codex agent', () => {
  const CODEX = 'This agent runs on Codex, which can\'t open attached files yet. Remove the files to send your message.';

  test('are refused codex-files before anything is written, and no Codex turn starts', async () => {
    assert.strictEqual(listing(attachmentsDir()), null, 'no attachments folder before the message');
    const id = h.freshConvoId('codex');
    await refusedWith({ type: 'chat', conversationId: id, agent: 'researcher', content: 'CODEX-FILES see this', attachments: [file('Screen Shot.png', png())] },
      { code: 'codex-files', title: NOT_SENT, text: CODEX });
    assert.strictEqual(listing(attachmentsDir()), null, 'and none after it');
    assert.deepStrictEqual(h.codexTurnPrompts().filter((p) => p.includes('CODEX-FILES')), [], 'Codex is sent nothing');
  });

  test('an empty list of files to a Codex agent is a text-only message and goes to Codex', async () => {
    const id = h.freshConvoId('codex-empty');
    h.writeCodexScenario([{ match: { promptIncludes: 'CODEX-EMPTY' }, text: 'DONE-CODEX-EMPTY' }]);
    const since = client.messages.length;
    client.send({ type: 'chat', conversationId: id, agent: 'researcher', content: 'CODEX-EMPTY just words', attachments: [] });
    assert.ok(await h.waitUntil(() => h.codexTurnPrompts().some((p) => p.includes('CODEX-EMPTY just words')), { timeout: 15000 }),
      'Codex is sent the message');
    await client.waitForEvent('system', 'done', id);
    const answered = client.messages.slice(since).filter((m) => m.conversationId === id);
    assert.ok(!answered.some((m) => m.type === 'chat_refused' || m.type === 'chat_stored'), 'with no attachment answer');
    assert.strictEqual(listing(attachmentsDir()), null, 'and nothing written under .rundock');
    h.reapConvo(id);
  });

  test('the same message to a Claude agent is stored', async () => {
    const id = h.freshConvoId('claude');
    answers(['CODEX-FILES']);
    const since = client.messages.length;
    chat(id, 'CODEX-FILES see this', [file('Screen Shot.png', png())]);
    const stored = await storedFor(id, since);
    assert.ok(stored, 'the message is answered with chat_stored');
    assert.ok(await resultFor(id, 'DONE-CODEX-FILES', since), 'and dispatched');
    writtenOnce(id, [stored]);
    h.reapConvo(id);
  });
});

describe('the frame limit', () => {
  test('the server reads frames of up to 28,000,000 bytes', () => {
    assert.strictEqual(h.internal.wss.options.maxPayload, 28000000);
  });

  test('a frame of exactly 28,000,000 bytes is read and answered', async () => {
    assert.strictEqual(h.internal.wss.options.maxPayload, 28000000, 'the limit is this frame\'s size');
    const c = await h.connect();
    c.ws.send(padded('get_conversations', 28000000));
    assert.ok(await arrived((m) => m.type === 'conversations', { on: c, timeout: 20000 }), 'a frame at the limit is answered');
    c.close();
  });

  test('a frame of 28,000,001 bytes closes its own socket with 1009, and the server stays up', async () => {
    const c = await h.connect();
    let code = null;
    c.ws.on('close', (closedWith) => { code = closedWith; });
    // The server runs in this process, where node:test would catch an error
    // the server left unhandled, so the server staying up is checked here.
    const uncaught = [];
    const logged = [];
    const onUncaught = (e) => uncaught.push(e && e.message);
    const error = console.error;
    process.on('uncaughtException', onUncaught);
    console.error = (...args) => { logged.push(args.map(String).join(' ')); };
    try {
      c.ws.send(padded('get_conversations', 28000001));
      await h.waitUntil(() => code !== null, { timeout: 10000 });
    } finally {
      console.error = error;
      process.removeListener('uncaughtException', onUncaught);
    }
    assert.strictEqual(code, 1009, 'the frame one byte over closes its socket as too big');
    assert.ok(!c.messages.some((m) => m.type === 'conversations'), 'and is never read');
    assert.deepStrictEqual(uncaught, [], 'the socket\'s error is handled, so it cannot end the server');
    assert.ok(logged.some((line) => line.startsWith('[WS] socket error:')), 'and it is logged');

    const fresh = await h.connect();
    fresh.send({ type: 'get_conversations' });
    assert.ok(await arrived((m) => m.type === 'conversations', { on: fresh }), 'a new connection is answered');
    const since = client.messages.length;
    client.send({ type: 'get_conversations' });
    assert.ok(await arrived((m) => m.type === 'conversations', { since }), 'and so is a socket that was already open');
    fresh.close();
  });

  test('two PDFs of 10,000,000 bytes, the most one message may hold, fit in one frame and are stored', async () => {
    const id = h.freshConvoId('largest');
    answers(['ASK-LARGEST']);
    const since = client.messages.length;
    chat(id, 'ASK-LARGEST', [file('alpha.pdf', pdf(10000000)), file('beta.pdf', pdf(10000000))]);
    const stored = await storedFor(id, since, 20000);
    assert.ok(stored, 'the message is answered with chat_stored');
    assert.ok(await resultFor(id, 'DONE-ASK-LARGEST', since), 'and dispatched');
    h.reapConvo(id);
  });
});

describe('a refused message writes, records, appends and dispatches nothing', () => {
  const notes = () => file('notes.txt', Buffer.from('hello'));

  test('six files', async () => {
    const id = h.freshConvoId('six');
    const got = await refusedWith({ type: 'chat', conversationId: id, agent: 'chief-of-staff', content: 'six', attachments: Array.from({ length: 6 }, notes) },
      { code: 'too-many-files', title: '6 files not added', text: 'That would make 6 files; the limit is 5 per message' });
    assert.ok(!('name' in got), 'a refusal of the whole message names no file');
    assert.strictEqual(listing(folderOf(id)), null);
  });

  test('three files of 20,000,001 bytes in all', async () => {
    const id = h.freshConvoId('bytes');
    const attachments = [file('alpha.pdf', pdf(10000000)), file('beta.pdf', pdf(10000000)), file('notes.txt', Buffer.from('x'))];
    await refusedWith({ type: 'chat', conversationId: id, agent: 'chief-of-staff', content: 'all', attachments },
      { code: 'too-many-bytes', title: '3 files not added', text: 'That would make 21 MB; the limit is 20 MB per message' });
    assert.strictEqual(listing(folderOf(id)), null);
  });

  for (const [label, attachments] of [['data that is not base64', [{ name: 'notes.txt', data: '!!!!' }]], ['attachments of null', null]]) {
    test(label, async () => {
      const id = h.freshConvoId('shape');
      await refusedWith({ type: 'chat', conversationId: id, agent: 'chief-of-staff', content: 'shape', attachments },
        { code: 'bad-payload', title: NOT_SENT, text: FALLBACK });
      assert.strictEqual(listing(folderOf(id)), null);
    });
  }

  test('files with no conversation ID, and nothing under default', async () => {
    await refusedWith({ type: 'chat', agent: 'chief-of-staff', content: 'no id', attachments: [notes()] },
      { code: 'bad-id', title: NOT_SENT, text: FALLBACK });
    assert.strictEqual(listing(folderOf('default')), null);
  });

  test('a conversation listed as deleted', async () => {
    const id = h.freshConvoId('gone');
    const list = path.join(attachmentsDir(), 'deleted.json');
    fs.mkdirSync(attachmentsDir(), { recursive: true });
    const was = fs.existsSync(list) ? JSON.parse(fs.readFileSync(list, 'utf-8')) : [];
    fs.writeFileSync(list, JSON.stringify([...was, id]));
    await refusedWith({ type: 'chat', conversationId: id, agent: 'chief-of-staff', content: 'gone', attachments: [notes()] },
      { code: 'deleted', title: NOT_SENT, text: 'This conversation was deleted in another window.' });
    assert.strictEqual(listing(folderOf(id)), null);
  });

  test('a deleted list that does not parse', async () => {
    const id = h.freshConvoId('junk');
    const list = path.join(attachmentsDir(), 'deleted.json');
    fs.mkdirSync(attachmentsDir(), { recursive: true });
    const was = fs.existsSync(list) ? fs.readFileSync(list) : null;
    fs.writeFileSync(list, 'not json');
    try {
      await refusedWith({ type: 'chat', conversationId: id, agent: 'chief-of-staff', content: 'junk', attachments: [notes()] },
        { code: 'save-failed', title: NOT_SENT, text: FALLBACK });
      assert.strictEqual(listing(folderOf(id)), null);
    } finally {
      if (was) fs.writeFileSync(list, was); else fs.rmSync(list, { force: true });
    }
  });

  test('attachments of null is refused bad-payload while five other conversations are being written, and those five are stored once released', async () => {
    const ids = Array.from({ length: 5 }, () => h.freshConvoId('load'));
    answers(['ASK-LOAD-']);
    // Each conversation's lock held, as a long write holds it.
    const releases = [];
    const held = ids.map((id) => store.withConversationLock(id, () => new Promise((resolve) => { releases.push(resolve); })));
    const since = client.messages.length;
    try {
      ids.forEach((id, n) => chat(id, `ASK-LOAD-${n} see this`, [file(`shot-${n}.png`, png())]));
      await h.delay(200);
      assert.ok(!client.messages.slice(since).some((m) => m.type === 'chat_stored'), 'the five are still being written');
      await refusedWith({ type: 'chat', conversationId: h.freshConvoId('null'), agent: 'chief-of-staff', content: 'null', attachments: null },
        { code: 'bad-payload', title: NOT_SENT, text: FALLBACK });
      assert.ok(!client.messages.slice(since).some((m) => m.type === 'chat_stored'), 'and still were when it was refused');
    } finally {
      for (const release of releases) release();
      await Promise.all(held);
    }
    for (const id of ids) assert.ok(await storedFor(id, since), `${id} is answered with chat_stored once released`);
    for (const [n, id] of ids.entries()) {
      assert.ok(await resultFor(id, 'DONE-ASK-LOAD-', since), `${id} is dispatched`);
      assert.deepStrictEqual(promptsWith(`ASK-LOAD-${n} see this`).length, 1);
      h.reapConvo(id);
    }
  });
});

// A message with two files to a fresh conversation, its turn ended, and the
// session id its run reports.
async function storedMessage(tag) {
  const id = h.freshConvoId(tag.toLowerCase());
  answers([tag], { keepSession: true });
  const since = client.messages.length;
  chat(id, `${tag} see these`, [file('Screen Shot.png', png()), file('Incident-Report-22-Nov.pdf', pdf())]);
  const stored = await storedFor(id, since);
  assert.ok(stored, 'the message is answered with chat_stored');
  assert.ok(await resultFor(id, `DONE-${tag}`, since), 'and dispatched');
  const lines = [
    `[Attached: .rundock/attachments/${id}/1-Screen_Shot.png (PNG image, 1 KB)]`,
    `[Attached: .rundock/attachments/${id}/2-Incident-Report-22-Nov.pdf (PDF document, 1 KB)]`,
  ];
  assert.strictEqual(stored.content, [`${tag} see these`, ...lines].join('\n'));
  const read = h.readPrompts().filter((p) => p.prompt.includes(tag));
  assert.strictEqual(read.length, 1, 'the run is sent the message once');
  return { id, stored, lines, sessionId: read[0].sessionId };
}

async function historyOf(id, sessionId, limit) {
  const since = client.messages.length;
  client.send({ type: 'get_session_history', conversationId: id, sessionIds: [{ sessionId }], limit });
  const history = await arrived((m) => m.type === 'session_history' && m.conversationId === id, { since });
  assert.ok(history, 'the history is answered');
  return history.messages.filter((m) => m.role === 'user');
}

describe('a stored message carries the stored text into every copy a reload reads', () => {
  test('see these with a 1,200,000-byte PNG, as the first message to alpha: chat_stored, the record, the file and the transcript row', async () => {
    const id = 'alpha';
    assert.ok(!h.internal.readConversations().some((c) => c.id === id), 'a conversation not in the list');
    scenario([{ match: { promptIncludes: 'see these' }, turn: [{ text: 'DONE-ALPHA' }] }]);
    const sent = [file('Screen Shot.png', png(640, 480, 1200000))];
    const since = client.messages.length;
    chat(id, 'see these', sent);
    const stored = await storedFor(id, since);
    assert.ok(stored, 'the message is answered with chat_stored');
    assert.deepStrictEqual(Object.keys(stored).sort(), ['content', 'conversationId', 'entry', 'type']);
    const line = '[Attached: .rundock/attachments/alpha/1-Screen_Shot.png (PNG image, 1.2 MB)]';
    assert.strictEqual(stored.content, `see these\n${line}`);
    assert.ok(await resultFor(id, 'DONE-ALPHA', since), 'and dispatched');
    writtenOnce(id, [stored]);
    assert.strictEqual(userRows(id)[0].text, stored.content, 'the transcript row\'s text is the stored text');

    const [described] = stored.entry.files;
    assert.strictEqual(described.file, nameIn(line));
    const bytes = fs.readFileSync(path.join(folderOf(id), described.file));
    assert.ok(bytes.equals(decoded(sent[0])), 'the stored file holds the bytes sent');
    assert.strictEqual(described.sha256, sha256(bytes));
    assert.strictEqual(store.checkRecordedFile(h.workspaceDir, id, described.file), 'present');
    const list = JSON.stringify(h.internal.readConversations());
    assert.ok(!list.includes('see these') && !list.includes('[Attached:'), 'the conversation list holds no message text');
    h.reapConvo(id);
  });

  test('the prompt the runtime reads holds the whole stored text', async () => {
    const { id, stored } = await storedMessage('ASK-PROMPT');
    assert.ok(h.promptsFor('chief-of-staff').some((p) => p.includes(stored.content)), 'one prompt holds the whole stored text');
    assert.deepStrictEqual(promptsWith('ASK-PROMPT'), [stored.content]);
    h.reapConvo(id);
  });

  test('the runtime\'s session file for the turn holds a user message with the whole stored text', async () => {
    const { id, stored, sessionId } = await storedMessage('ASK-SESSION');
    const project = fs.realpathSync(h.workspaceDir).replace(/[^a-zA-Z0-9]/g, '-');
    const at = path.join(process.env.HOME, '.claude', 'projects', project, `${sessionId}.jsonl`);
    assert.ok(fs.existsSync(at), `the session file is at ${at}`);
    const user = fs.readFileSync(at, 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
      .filter((l) => l.type === 'user' && typeof l.message.content === 'string');
    assert.ok(user.some((l) => l.message.content.includes(stored.content)), 'a user message holds the whole stored text');
    h.reapConvo(id);
  });

  test('the history holds every line while the transcript row is in place', async () => {
    const { id, lines, sessionId } = await storedMessage('ASK-HISTORY');
    assert.ok(userRows(id).some((r) => r.text.includes('[Attached:')), 'the row is in place');
    const user = await historyOf(id, sessionId, 200);
    assert.strictEqual(user.length, 1);
    for (const line of lines) assert.ok(user[0].content.includes(line), `the history's user message holds ${line}`);
    h.reapConvo(id);
  });

  // The transcript's cap never drops its first row, and this message's row is
  // the first, so the row is dropped here by emptying the transcript before
  // the 1,000 rows go in. The first row left is then stamped over a second
  // after the message, and the session line counts as history from before
  // the transcript began: shown only if the session file carries it.
  test('the history holds every line from the session file once the transcript row has been dropped', async () => {
    const { id, lines, sessionId } = await storedMessage('ASK-DROPPED');
    await h.delay(1100);
    h.internal.convoTranscripts.get(id).splice(0);
    for (let i = 0; i < 1000; i++) h.internal.appendTranscript(id, 'user', 'user', `filler ${i}`);
    assert.ok(!rows(id).some((r) => r.text.includes('[Attached:')), 'the row with the lines is dropped');
    assert.strictEqual(rows(id)[0].role, 'user');
    const user = await historyOf(id, sessionId, 2000);
    const found = user.filter((m) => m.content.includes('[Attached:'));
    assert.strictEqual(found.length, 1, 'one user message holds the lines');
    for (const line of lines) assert.ok(found[0].content.includes(line), `the history's user message holds ${line}`);
    h.reapConvo(id);
  });

  test('the record entry outlives the transcript row the cap drops', async () => {
    const id = h.freshConvoId('capped');
    answers(['ASK-PLAIN', 'ASK-CAPPED']);
    const since = client.messages.length;
    chat(id, 'ASK-PLAIN first', undefined);
    assert.ok(await resultFor(id, 'DONE-ASK-PLAIN', since));
    chat(id, 'ASK-CAPPED see these', [file('Screen Shot.png', png())]);
    const stored = await storedFor(id, since);
    assert.ok(stored, 'the message is answered with chat_stored');
    assert.ok(await resultFor(id, 'DONE-ASK-CAPPED', since));
    for (let i = 0; i < 1000; i++) h.internal.appendTranscript(id, 'user', 'user', `filler ${i}`);
    assert.strictEqual(rows(id)[0].text, 'ASK-PLAIN first');
    assert.ok(!rows(id).some((r) => r.text.includes('[Attached:')), 'the row with the lines is dropped');
    assert.deepStrictEqual(entriesOf(id), [stored.entry], 'the record still holds the entry unchanged');
    for (const f of stored.entry.files) assert.strictEqual(store.checkRecordedFile(h.workspaceDir, id, f.file), 'present');
    h.reapConvo(id);
  });

  for (const [label, attachments] of [['without attachments', undefined], ['with an empty list', []]]) {
    test(`a text-only message ${label} is dispatched as typed and writes nothing`, async () => {
      const id = h.freshConvoId('plain');
      answers(['ASK-FILES', 'ASK-TEXT']);
      // A message with files first, so there is a folder and a record for the
      // text-only message to leave as they are.
      const first = client.messages.length;
      chat(id, 'ASK-FILES see this', [file('Screen Shot.png', png())]);
      const stored = await storedFor(id, first);
      assert.ok(stored, 'the message with files before it is answered with chat_stored');
      assert.ok(await resultFor(id, 'DONE-ASK-FILES', first), 'and dispatched');
      const before = listing(attachmentsDir());
      const folder = bytesIn(folderOf(id));
      const record = entriesOf(id);
      const rec = recordReentries();
      const since = client.messages.length;
      try {
        chat(id, 'ASK-TEXT just words', attachments);
        assert.ok(await resultFor(id, 'DONE-ASK-TEXT', since), 'the message is dispatched');
      } finally {
        rec.stop();
      }
      assert.deepStrictEqual(listing(attachmentsDir()), before, 'nothing written under .rundock/attachments');
      assert.deepStrictEqual(bytesIn(folderOf(id)), folder, 'the conversation\'s folder and its files as they were');
      assert.deepStrictEqual(entriesOf(id), record, 'and its record');
      const [, row, ...more] = userRows(id);
      assert.deepStrictEqual([userRows(id)[0].text, row.text, more.length], [stored.content, 'ASK-TEXT just words', 0]);
      assert.ok(!('attachments' in row) && !('attachmentEntry' in row));
      assert.deepStrictEqual(promptsWith('ASK-TEXT just words').slice(-1), ['ASK-TEXT just words']);
      for (const m of rec.seen.filter((s) => s.conversationId === id)) {
        assert.ok(!('attachments' in m) && !('attachmentEntry' in m), 'what reaches the handler carries no attachment fields');
      }
      h.reapConvo(id);
    });
  }
});

describe('after every test above', () => {
  test('no receive ended in an unhandled rejection', () => {
    const answered = new Set(client.messages.map((m) => m.type));
    assert.ok(answered.has('chat_stored') && answered.has('chat_refused'), 'messages with files were stored and refused above');
    assert.deepStrictEqual(rejections, []);
  });
});
