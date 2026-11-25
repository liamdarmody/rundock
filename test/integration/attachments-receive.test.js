'use strict';
// Integration: a chat message's attachments through the real server.
//
// A message with files is stored once, with its record entry, before it can
// reach the transition buffer. From there it carries the stored text and the
// entry's ID, never the file data, on every path back into the handler: the
// buffer's replay, both resume retries and the carried loop. A refused message
// is answered with one chat_refused and writes, records, appends and
// dispatches nothing. A frame over the limit closes only its own socket.
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
const { handleDeleteConversation } = require('../../lib/protocol/handlers/conversations.js');
const { makeTempDir } = require('../helpers/workspace.js');
const tfx = require('../fixtures/session-transcript.js');

// The receive is async and the handler ignores its promise, so a rejection it
// failed to catch would surface only here.
const rejections = [];
process.on('unhandledRejection', (reason) => { rejections.push(reason); });

let client;
before(async () => { await h.boot(); client = await h.connect(); });
after(async () => h.shutdown());

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
const spawnsFor = (id) => h.readInvocations().filter((i) => i.env && i.env.RUNDOCK_CONVO_ID === id);
const promptsWith = (tag) => h.readPrompts().map((p) => p.prompt).filter((p) => p.includes(tag));

function scenario(rules, deadSessions = [], extra = {}) {
  fs.writeFileSync(path.join(h.workspaceDir, 'stub-scenario.json'), JSON.stringify({ ...extra, rules, deadSessions }));
}
const answers = (...tags) => scenario(tags.map((tag) => ({ match: { promptIncludes: tag }, turn: [{ text: `DONE-${tag}` }] })));

function seed(id, record) {
  const all = h.internal.readConversations().filter((c) => c.id !== id);
  h.internal.writeConversations([{ id, title: id, status: 'active', ...record }, ...all]);
}

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
  const was = { spawns: h.readInvocations().length, prompts: h.readPrompts().length, rows: rows(id || 'default').length };
  const folder = listing(folderOf(id || 'default'));
  const bytes = bytesIn(folderOf(id || 'default'));
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
  assert.strictEqual(rows(id || 'default').length, was.rows, 'no transcript row');
  assert.strictEqual(h.readInvocations().length, was.spawns, 'no process spawned');
  assert.strictEqual(h.readPrompts().length, was.prompts, 'nothing written to a stdin');
  assert.deepStrictEqual(listing(folderOf(id || 'default')), folder, 'the attachments folder as it was');
  assert.deepStrictEqual(bytesIn(folderOf(id || 'default')), bytes, 'every file already there holds the bytes it held');
  if (id) assert.deepStrictEqual(entriesOf(id), record, 'no record entry');
  return got;
}

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
    answers('ASK-LARGEST');
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
        { code: 'bad-payload', title: 'Message not sent', text: FALLBACK });
      assert.strictEqual(listing(folderOf(id)), null);
    });
  }

  test('files with no conversation ID, and nothing under default', async () => {
    await refusedWith({ type: 'chat', agent: 'chief-of-staff', content: 'no id', attachments: [notes()] },
      { code: 'bad-id', title: 'Message not sent', text: FALLBACK });
    assert.strictEqual(listing(folderOf('default')), null);
  });

  test('a conversation listed as deleted', async () => {
    const id = h.freshConvoId('gone');
    const list = path.join(attachmentsDir(), 'deleted.json');
    fs.mkdirSync(attachmentsDir(), { recursive: true });
    const was = fs.existsSync(list) ? JSON.parse(fs.readFileSync(list, 'utf-8')) : [];
    fs.writeFileSync(list, JSON.stringify([...was, id]));
    await refusedWith({ type: 'chat', conversationId: id, agent: 'chief-of-staff', content: 'gone', attachments: [notes()] },
      { code: 'deleted', title: 'Message not sent', text: 'This conversation was deleted in another window.' });
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
        { code: 'save-failed', title: 'Message not sent', text: FALLBACK });
      assert.strictEqual(listing(folderOf(id)), null);
    } finally {
      if (was) fs.writeFileSync(list, was); else fs.rmSync(list, { force: true });
    }
  });

  const refusals = [
    ['a forged reference', { attachmentEntry: 'no-such-entry' }, 'bad-entry'],
    ['files whose data is not base64', { attachments: [{ name: 'notes.txt', data: '!!!!' }] }, 'bad-payload'],
  ];
  for (const [label, extra, code] of refusals) {
    test(`${label}, to a conversation holding a stored file: its bytes, hash, record and folder as they were`, async () => {
      const id = h.freshConvoId('keep');
      answers('ASK-KEEP');
      const sent = file('Screen Shot.png', png());
      const since = client.messages.length;
      chat(id, 'ASK-KEEP see this', [sent]);
      const stored = await storedFor(id, since);
      assert.ok(stored, 'the conversation holds a stored file');
      assert.ok(await resultFor(id, 'DONE-ASK-KEEP', since), 'and its message is answered');
      const [described] = stored.entry.files;
      const at = path.join(folderOf(id), described.file);
      const before = fs.readFileSync(at);
      assert.ok(before.equals(decoded(sent)), 'the stored file holds the bytes sent');
      const record = entriesOf(id);
      const folder = listing(folderOf(id));
      await refusedWith({ type: 'chat', conversationId: id, agent: 'chief-of-staff', content: 'ASK-KEEP again', ...extra },
        { code, title: 'Message not sent', text: FALLBACK });
      const after = fs.readFileSync(at);
      assert.ok(after.equals(before), 'the stored file holds the bytes it held');
      assert.strictEqual(sha256(after), sha256(before), 'and the same hash');
      assert.strictEqual(sha256(after), described.sha256, 'which is the hash its record gives');
      assert.deepStrictEqual(entriesOf(id), record, 'the record as it was');
      assert.deepStrictEqual(listing(folderOf(id)), folder, 'the folder listing as it was');
      assert.strictEqual(store.checkRecordedFile(h.workspaceDir, id, described.file), 'present');
      h.reapConvo(id);
    });
  }
});

describe('a stored message carries the stored text into every copy a reload reads', () => {
  test('chat_stored, the record, the files sent and the lines in the transcript, the prompt and the history', async () => {
    const id = h.freshConvoId('stored');
    answers('ASK-STORED');
    assert.ok(!h.internal.readConversations().some((c) => c.id === id), 'a first message, to a conversation not in the list');
    const sent = [file('Screen Shot.png', png(640, 480, 1200000)), file('Incident-Report-22-Nov.pdf', pdf())];
    const since = client.messages.length;
    chat(id, 'ASK-STORED see these', sent);
    const stored = await storedFor(id, since);
    assert.ok(stored, 'the message is answered with chat_stored');
    assert.deepStrictEqual(Object.keys(stored).sort(), ['content', 'conversationId', 'entry', 'type']);
    const lines = [
      `[Attached: .rundock/attachments/${id}/1-Screen_Shot.png (PNG image, 1.2 MB)]`,
      `[Attached: .rundock/attachments/${id}/2-Incident-Report-22-Nov.pdf (PDF document, 1 KB)]`,
    ];
    assert.strictEqual(stored.content, ['ASK-STORED see these', ...lines].join('\n'));
    assert.ok(await resultFor(id, 'DONE-ASK-STORED', since), 'and dispatched');
    writtenOnce(id, [stored]);

    // Each line names a file of the entry, holding exactly the bytes sent.
    for (const [i, line] of lines.entries()) {
      const name = /\/([^/ ]+) \(/.exec(line)[1];
      const described = stored.entry.files[i];
      assert.strictEqual(described.file, name);
      const bytes = fs.readFileSync(path.join(folderOf(id), name));
      assert.ok(bytes.equals(decoded(sent[i])), `${name} holds the bytes sent`);
      assert.strictEqual(described.sha256, sha256(bytes));
      assert.strictEqual(store.checkRecordedFile(h.workspaceDir, id, name), 'present');
    }

    assert.deepStrictEqual(promptsWith('ASK-STORED'), [stored.content], 'the prompt carries every line, once');
    const hs = client.messages.length;
    client.send({ type: 'get_session_history', conversationId: id, sessionIds: [], limit: 200 });
    const history = await arrived((m) => m.type === 'session_history' && m.conversationId === id, { since: hs });
    assert.ok(history, 'the history is answered');
    const user = history.messages.filter((m) => m.role === 'user');
    assert.strictEqual(user.length, 1);
    for (const line of lines) assert.ok(user[0].content.includes(line), `the history's user message holds ${line}`);
    const list = JSON.stringify(h.internal.readConversations());
    assert.ok(!list.includes('ASK-STORED') && !list.includes('[Attached:'), 'the conversation list holds no message text');
    h.reapConvo(id);
  });

  // The stub keeps a session file only for a spawn given --session-id, which a
  // chat's spawn is not given, so the file is written here as the runtime
  // writes it: its user line is the prompt the stub read, byte for byte.
  test('the runtime reads the stored text, and with no transcript the history takes every line from the runtime\'s session file', async () => {
    const id = h.freshConvoId('runtime');
    answers('ASK-RUNTIME');
    const since = client.messages.length;
    chat(id, 'ASK-RUNTIME see these', [file('Screen Shot.png', png())]);
    const stored = await storedFor(id, since);
    assert.ok(stored, 'the message is answered with chat_stored');
    assert.ok(await resultFor(id, 'DONE-ASK-RUNTIME', since), 'and dispatched');
    const read = h.readPrompts().filter((p) => p.prompt.includes('ASK-RUNTIME'));
    assert.deepStrictEqual(read.map((p) => p.prompt), [stored.content], 'the runtime reads the stored text, once');

    const { sessionId, prompt } = read[0];
    const dir = path.join(process.env.HOME, '.claude', 'projects', 'stub-project');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${sessionId}.jsonl`), tfx.prompt(sessionId, prompt, new Date().toISOString()));
    // With the transcript gone, the session file is the whole history.
    h.internal.convoTranscripts.get(id).splice(0);
    assert.deepStrictEqual(rows(id), [], 'no transcript to supply the row');
    const hs = client.messages.length;
    client.send({ type: 'get_session_history', conversationId: id, sessionIds: [{ sessionId }], limit: 200 });
    const history = await arrived((m) => m.type === 'session_history' && m.conversationId === id, { since: hs });
    assert.ok(history, 'the history is answered');
    assert.deepStrictEqual(history.messages.filter((m) => m.role === 'user').map((m) => m.content), [stored.content],
      'the history\'s user message is the stored text, every line included');
    h.reapConvo(id);
  });

  test('the record entry outlives the transcript row the cap drops', async () => {
    const id = h.freshConvoId('capped');
    answers('ASK-PLAIN', 'ASK-CAPPED');
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
      answers('ASK-FILES', 'ASK-TEXT');
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

describe('every path back into the handler writes once and records once', () => {
  test('the transition buffer queues the stored message, and its replay writes nothing more', async () => {
    const id = h.freshConvoId('buffered');
    answers('ASK-BUF');
    const sent = [file('Screen Shot.png', png()), file('Incident-Report-22-Nov.pdf', pdf())];
    const t = { state: 'killing', owner: {}, queued: [], failsafe: setTimeout(() => {}, 30000) };
    h.internal.convoTransitions.set(id, t);
    try {
      const since = client.messages.length;
      chat(id, 'ASK-BUF see these', sent);
      assert.ok(await h.waitUntil(() => t.queued.length > 0), 'the message is queued');
      const record = entriesOf(id) || [];
      assert.strictEqual(record.length, 1, 'the record holds the entry before the message is queued');
      assert.strictEqual(record[0].id, t.queued[0].attachmentEntry);
      assert.deepStrictEqual(record[0].files.map((f) => f.sha256), sent.map((f) => sha256(decoded(f))));
      const queue = JSON.stringify(t.queued);
      assert.ok(!queue.includes('"attachments"'), 'the queue holds no attachments');
      for (const f of sent) assert.ok(!queue.includes(f.data), 'and none of the data sent');
      const stored = await storedFor(id, since);
      h.internal.wsHandlerContext.transitions.endConvoTransition(id);
      assert.ok(await resultFor(id, 'DONE-ASK-BUF', since), 'the replay is dispatched');
      assert.deepStrictEqual(promptsWith('ASK-BUF'), [stored.content], 'once, with the stored text');
      writtenOnce(id, [stored]);
    } finally {
      if (h.internal.convoTransitions.get(id) === t) h.internal.wsHandlerContext.transitions.endConvoTransition(id);
      h.reapConvo(id);
    }
  });

  for (const legacy of [false, true]) {
    test(`the ${legacy ? 'legacy' : 'interactive'} resume retry carries the stored text and writes nothing again`, async () => {
      const id = h.freshConvoId(legacy ? 'retry-legacy' : 'retry');
      const dead = legacy ? 'dead-orch-ff' : 'dead-orch-ee';
      seed(id, { agentId: 'chief-of-staff', sessionId: dead, sessionIds: [{ agentId: 'chief-of-staff', sessionId: dead }] });
      scenario([{ match: { promptIncludes: 'ASK-RETRY' }, turn: [{ text: 'FRESH-RETRY' }] }], [dead], { refusalAfterInit: true });
      h.clearInvocations();
      if (legacy) process.env.RUNDOCK_LEGACY_SPAWN = '1';
      const rec = recordReentries();
      const since = client.messages.length;
      let stored;
      try {
        chat(id, 'ASK-RETRY see this', [file('Screen Shot.png', png())], { sessionId: dead });
        stored = await storedFor(id, since);
        assert.ok(stored, 'the message is answered with chat_stored');
        assert.ok(await resultFor(id, 'FRESH-RETRY', since), 'the fresh start answers');
      } finally {
        rec.stop();
        delete process.env.RUNDOCK_LEGACY_SPAWN;
      }
      assert.deepStrictEqual(spawnsFor(id).map((i) => i.resume), [dead, null], 'refused once, then started fresh');
      const entered = rec.seen.filter((m) => m.conversationId === id);
      assert.deepStrictEqual(entered.map((m) => [m.content, m.attachmentEntry, 'attachments' in m, !!m._resumeRetry]),
        [[stored.content, stored.entry.id, false, false], [stored.content, stored.entry.id, false, true]],
        'both dispatches carry the same stored text and reference, and no files');
      assert.deepStrictEqual(promptsWith('ASK-RETRY'), [stored.content]);
      writtenOnce(id, [stored]);
      h.reapConvo(id);
    });
  }

  test('a second message with files, sent while the refused resume is still starting, is stored once and follows the first', async () => {
    const id = h.freshConvoId('carried');
    seed(id, { agentId: 'chief-of-staff', sessionId: 'dead-orch-s', sessionIds: [{ agentId: 'chief-of-staff', sessionId: 'dead-orch-s' }] });
    scenario([
      { match: { promptIncludes: 'FIRST-S' }, turn: [{ text: 'DONE-FIRST-S' }] },
      { match: { promptIncludes: 'SECOND-S' }, turn: [{ text: 'DONE-SECOND-S' }] },
    ], ['dead-orch-s'], { refusalExitMs: 1200 });
    h.clearInvocations();
    const since = client.messages.length;
    chat(id, 'FIRST-S hello', [file('Screen Shot.png', png())], { sessionId: 'dead-orch-s' });
    const first = await storedFor(id, since);
    assert.ok(first, 'the first is answered with chat_stored');
    assert.ok(await arrived((m) => m.subtype === 'session_expired' && m._conversationId === id, { since, timeout: 15000 }),
      'the resume is refused and still lingering');
    const mid = client.messages.length;
    chat(id, 'SECOND-S and this', [file('notes.txt', Buffer.from('hello'))]);
    const second = await storedFor(id, mid);
    assert.ok(second, 'the second is answered with chat_stored');
    assert.ok(await resultFor(id, 'DONE-SECOND-S', since), 'the second is answered');
    assert.deepStrictEqual(promptsWith('-S '), [first.content, second.content], 'each text reaches the fresh process once, in order');
    writtenOnce(id, [first, second]);
    h.reapConvo(id);
  });

  // The record changed after the message was stored and before the server
  // sent it back into the handler: its entry taken out, or the record left
  // unreadable. Each re-entry is then refused, and nothing reaches a process.
  const BROKEN = [['removed', 'gone from the record'], ['unreadable', 'in a record that cannot be read']];
  function breakRecord(id, entryId, how) {
    const at = path.join(folderOf(id), 'record.json');
    if (how === 'unreadable') { fs.writeFileSync(at, 'not json'); return; }
    const record = JSON.parse(fs.readFileSync(at, 'utf-8'));
    record.messages = record.messages.filter((m) => !m || m.id !== entryId);
    fs.writeFileSync(at, JSON.stringify(record));
  }
  // Every chat_refused for `id` after `since`, once the first has arrived and
  // the re-entries have had time to do anything else.
  async function refusedOnReentry(id, since) {
    const refused = (m) => m.type === 'chat_refused' && m.conversationId === id;
    assert.ok(await arrived(refused, { since }), 'the re-entry is answered with chat_refused');
    await h.delay(500);
    return client.messages.slice(since).filter(refused).map((m) => [m.code, m.title, m.text]);
  }
  const BAD_ENTRY = ['bad-entry', 'Message not sent', FALLBACK];

  for (const [how, label] of BROKEN) {
    test(`the transition buffer's replay is refused when its entry is ${label}, and reaches no process`, async () => {
      const id = h.freshConvoId('buffered-broken');
      answers('ASK-BUFBROKEN');
      const t = { state: 'killing', owner: {}, queued: [], failsafe: setTimeout(() => {}, 30000) };
      h.internal.convoTransitions.set(id, t);
      try {
        const since = client.messages.length;
        chat(id, 'ASK-BUFBROKEN see this', [file('Screen Shot.png', png())]);
        const stored = await storedFor(id, since);
        assert.ok(stored, 'the message is answered with chat_stored');
        assert.ok(await h.waitUntil(() => t.queued.length > 0), 'and queued');
        breakRecord(id, stored.entry.id, how);
        const replay = client.messages.length;
        h.internal.wsHandlerContext.transitions.endConvoTransition(id);
        assert.deepStrictEqual(await refusedOnReentry(id, replay), [BAD_ENTRY], 'one bad-entry refusal');
        assert.deepStrictEqual(userRows(id), [], 'no transcript row');
        assert.deepStrictEqual(spawnsFor(id), [], 'no process started');
        assert.deepStrictEqual(promptsWith('ASK-BUFBROKEN'), [], 'nothing written to a stdin');
      } finally {
        if (h.internal.convoTransitions.get(id) === t) h.internal.wsHandlerContext.transitions.endConvoTransition(id);
        h.reapConvo(id);
      }
    });
  }

  for (const legacy of [false, true]) {
    for (const [how, label] of BROKEN) {
      test(`the ${legacy ? 'legacy' : 'interactive'} resume retry is refused when its entry is ${label}, and reaches no process`, async () => {
        const id = h.freshConvoId(legacy ? 'retry-legacy-broken' : 'retry-broken');
        const dead = `dead-broken-${legacy ? 'legacy' : 'interactive'}-${how}`;
        seed(id, { agentId: 'chief-of-staff', sessionId: dead, sessionIds: [{ agentId: 'chief-of-staff', sessionId: dead }] });
        scenario([{ match: { promptIncludes: 'ASK-RETRYBROKEN' }, turn: [{ text: 'FRESH-RETRYBROKEN' }] }], [dead], { refusalExitMs: 2000 });
        h.clearInvocations();
        if (legacy) process.env.RUNDOCK_LEGACY_SPAWN = '1';
        const since = client.messages.length;
        let stored;
        let refusals;
        try {
          chat(id, 'ASK-RETRYBROKEN see this', [file('Screen Shot.png', png())], { sessionId: dead });
          stored = await storedFor(id, since);
          assert.ok(stored, 'the message is answered with chat_stored');
          assert.ok(await arrived((m) => m.subtype === 'session_expired' && m._conversationId === id, { since, timeout: 15000 }),
            'the resume is refused and still lingering');
          assert.strictEqual(spawnsFor(id).length, 1, 'and not yet retried');
          breakRecord(id, stored.entry.id, how);
          refusals = await refusedOnReentry(id, since);
        } finally {
          delete process.env.RUNDOCK_LEGACY_SPAWN;
        }
        assert.deepStrictEqual(refusals, [BAD_ENTRY], 'one bad-entry refusal');
        assert.deepStrictEqual(spawnsFor(id).map((i) => i.resume), [dead], 'the refused resume, and no fresh start');
        assert.deepStrictEqual(promptsWith('ASK-RETRYBROKEN'), [], 'nothing written to a stdin');
        assert.deepStrictEqual(userRows(id).map((r) => r.text), [stored.content], 'the first pass\'s row, and none for the retry');
        h.reapConvo(id);
      });
    }
  }

  for (const [how, label] of BROKEN) {
    test(`the carried loop is refused when the first message's entry is ${label}, and reaches no process`, async () => {
      const id = h.freshConvoId('carried-broken');
      const dead = `dead-broken-carried-${how}`;
      seed(id, { agentId: 'chief-of-staff', sessionId: dead, sessionIds: [{ agentId: 'chief-of-staff', sessionId: dead }] });
      scenario([
        { match: { promptIncludes: 'FIRST-CB' }, turn: [{ text: 'DONE-FIRST-CB' }] },
        { match: { promptIncludes: 'SECOND-CB' }, turn: [{ text: 'DONE-SECOND-CB' }] },
      ], [dead], { refusalExitMs: 2000 });
      h.clearInvocations();
      const since = client.messages.length;
      chat(id, 'FIRST-CB hello', [file('Screen Shot.png', png())], { sessionId: dead });
      const first = await storedFor(id, since);
      assert.ok(first, 'the first is answered with chat_stored');
      assert.ok(await arrived((m) => m.subtype === 'session_expired' && m._conversationId === id, { since, timeout: 15000 }),
        'the resume is refused and still lingering');
      const mid = client.messages.length;
      chat(id, 'SECOND-CB and this', [file('notes.txt', Buffer.from('hello'))]);
      const second = await storedFor(id, mid);
      assert.ok(second, 'the second is answered with chat_stored');
      assert.ok(await h.waitUntil(() => userRows(id).length === 2), 'and reaches the refused process');
      assert.strictEqual(spawnsFor(id).length, 1, 'which is not yet retried');
      breakRecord(id, first.entry.id, how);
      // The retry and the message carried after it both carry the first
      // message's reference, so each is refused.
      assert.deepStrictEqual(await refusedOnReentry(id, mid), [BAD_ENTRY, BAD_ENTRY], 'one bad-entry refusal for each re-entry');
      assert.deepStrictEqual(spawnsFor(id).map((i) => i.resume), [dead], 'the refused resume, and no fresh start');
      assert.deepStrictEqual(promptsWith('-CB '), [], 'nothing written to a stdin');
      assert.deepStrictEqual(userRows(id).map((r) => r.text), [first.content, second.content], 'the first pass\'s rows, and none for the retry');
      h.reapConvo(id);
    });
  }

  describe('a reference to a record entry, without files', () => {
    const own = h.freshConvoId('ref-own');
    const other = h.freshConvoId('ref-other');
    const broken = h.freshConvoId('ref-broken');
    let ownStored;
    let otherStored;

    // Asserts nothing, so each test below checks what it was given itself.
    before(async () => {
      answers('ASK-REF', 'REF-OK');
      for (const id of [own, other]) {
        const since = client.messages.length;
        chat(id, 'ASK-REF see this', [file('Screen Shot.png', png())]);
        const stored = await storedFor(id, since);
        await resultFor(id, 'DONE-ASK-REF', since);
        if (id === own) ownStored = stored; else otherStored = stored;
      }
      fs.mkdirSync(folderOf(broken), { recursive: true });
      fs.writeFileSync(path.join(folderOf(broken), 'record.json'), 'not json');
    });
    after(() => { h.reapConvo(own); h.reapConvo(other); });
    const holds = (id, stored) => {
      assert.ok(stored, `${id}'s message with files is answered with chat_stored`);
      assert.deepStrictEqual(entriesOf(id), [stored.entry], `${id} holds the entry its message stored`);
    };

    test('naming an entry of its own conversation is dispatched and writes nothing', async () => {
      holds(own, ownStored);
      const since = client.messages.length;
      chat(own, 'REF-OK again', undefined, { attachmentEntry: ownStored.entry.id });
      assert.ok(await resultFor(own, 'DONE-REF-OK', since), 'the message is dispatched');
      assert.deepStrictEqual(entriesOf(own), [ownStored.entry]);
      assert.deepStrictEqual(listing(folderOf(own)), [...ownStored.entry.files.map((f) => f.file), 'record.json'].sort());
    });

    const cases = [
      ['an unknown entry', () => { holds(own, ownStored); return [own, 'no-such-entry']; }],
      ['a number', () => { holds(own, ownStored); return [own, 42]; }],
      ['another conversation\'s entry', () => { holds(own, ownStored); holds(other, otherStored); return [own, otherStored.entry.id]; }],
      ['an entry of an unreadable record', () => {
        assert.throws(() => store.readRecord(h.workspaceDir, broken), { code: 'record-unreadable' }, 'its record does not parse');
        return [broken, 'any-entry'];
      }],
    ];
    for (const [label, pick] of cases) {
      test(`naming ${label} is refused`, async () => {
        const [id, attachmentEntry] = pick();
        await refusedWith({ type: 'chat', conversationId: id, agent: 'chief-of-staff', content: 'ASK-REF forged', attachmentEntry },
          { code: 'bad-entry', title: 'Message not sent', text: FALLBACK });
      });
    }
  });

  test('a later chat waits for the files before it, and another conversation does not', async () => {
    const id = h.freshConvoId('held');
    const elsewhere = h.freshConvoId('not-held');
    answers('HELD-A', 'HELD-B', 'HELD-C');
    let release;
    const held = store.withConversationLock(id, () => new Promise((resolve) => { release = resolve; }));
    const since = client.messages.length;
    chat(id, 'HELD-A see this', [file('Screen Shot.png', png())]);
    chat(id, 'HELD-B and then', undefined);
    chat(id, 'HELD-X forged', undefined, { attachmentEntry: 'no-such-entry' });
    chat(elsewhere, 'HELD-C meanwhile', undefined);
    try {
      assert.ok(await resultFor(elsewhere, 'DONE-HELD-C', since), 'another conversation is not held');
      assert.deepStrictEqual([spawnsFor(id).length, promptsWith('HELD-A').length, promptsWith('HELD-B').length], [0, 0, 0],
        'neither message reaches a process while the files wait');
      assert.ok(client.messages.slice(since).some((m) => m.type === 'chat_refused' && m.conversationId === id && m.code === 'bad-entry'),
        'a forged reference is refused on arrival, not let through behind the hold');
    } finally {
      release();
      await held;
    }
    const stored = await storedFor(id, since);
    assert.ok(stored, 'the files are stored once released');
    assert.ok(await resultFor(id, 'DONE-HELD-B', since), 'and the text after them is answered');
    assert.deepStrictEqual(h.readPrompts().map((p) => p.prompt).filter((p) => /HELD-[ABX]/.test(p)), [stored.content, 'HELD-B and then'],
      'in the order sent, and nothing forged');
    h.reapConvo(id);
    h.reapConvo(elsewhere);
  });
});

describe('at most four messages with files are taken in at a time, across sockets and conversations', () => {
  const BUSY = { code: 'busy', title: 'Message not sent', text: FALLBACK };
  const answersOf = (on, id, since) => on.messages.slice(since)
    .filter((m) => (m.type === 'chat_stored' || m.type === 'chat_refused') && m.conversationId === id);
  const storedOf = (id, since, on = client) => answersOf(on, id, since).filter((m) => m.type === 'chat_stored');
  const send = (on, id, content, attachments) => on.send({ type: 'chat', conversationId: id, agent: 'chief-of-staff', content, attachments });

  // Each conversation's lock held, as a long write would hold it, until the
  // returned release is awaited.
  function holdLocks(...ids) {
    const releases = [];
    const held = ids.map((id) => store.withConversationLock(id, () => new Promise((resolve) => { releases.push(resolve); })));
    return async () => { for (const r of releases) r(); await Promise.all(held); };
  }
  // Answered once every message `on` sent before it has been taken in.
  async function allTaken(on) {
    const since = on.messages.length;
    on.send({ type: 'get_conversations' });
    assert.ok(await arrived((m) => m.type === 'conversations', { since, on }), 'the socket\'s earlier messages are taken in');
  }

  // Five messages with files for one held conversation, then the release:
  // what was answered before it, and the four stored after it.
  async function fiveWhileHeld(tag) {
    const id = h.freshConvoId(tag.toLowerCase());
    answers(`${tag}-`);
    const release = holdLocks(id);
    const since = client.messages.length;
    let early;
    try {
      for (let n = 1; n <= 5; n++) chat(id, `${tag}-${n} see this`, [file(`shot-${n}.png`, png())]);
      await arrived((m) => m.type === 'chat_refused' && m.conversationId === id, { since });
      await h.delay(300);
      early = { answers: answersOf(client, id, since), spawns: spawnsFor(id).length, prompts: promptsWith(`${tag}-`).length };
    } finally {
      await release();
    }
    assert.ok(await h.waitUntil(() => storedOf(id, since).length >= 4), 'four are stored once released');
    assert.ok(await resultFor(id, `DONE-${tag}-`, since), 'and dispatched');
    assert.ok(await h.waitUntil(() => promptsWith(`${tag}-`).length >= 4), 'all four reach the process');
    await h.delay(300);
    return { id, since, early, stored: storedOf(id, since) };
  }

  test('of five sent while held, four wait and the fifth is refused busy at once, with nothing written for it', async () => {
    const { id, early, stored } = await fiveWhileHeld('FIVE');
    assert.deepStrictEqual(early.answers.map((m) => ({ code: m.code, title: m.title, text: m.text })), [BUSY],
      'before the release, only the fifth is answered, and it is refused busy');
    assert.deepStrictEqual([early.spawns, early.prompts], [0, 0], 'and nothing reaches a process while the four wait');
    writtenOnce(id, stored);
    assert.deepStrictEqual(promptsWith('FIVE-5'), [], 'the fifth reaches no process');
    h.reapConvo(id);
  });

  test('after the release, the four that waited are stored and dispatched in the order they arrived', async () => {
    const { id, stored } = await fiveWhileHeld('ORDER');
    assert.deepStrictEqual(stored.map((s) => s.content.split(' ')[0]), ['ORDER-1', 'ORDER-2', 'ORDER-3', 'ORDER-4'], 'stored in arrival order');
    assert.deepStrictEqual(promptsWith('ORDER-'), stored.map((s) => s.content), 'and dispatched in it, with their stored text');
    h.reapConvo(id);
  });

  test('the four are counted across two sockets and two conversations', async () => {
    const x = h.freshConvoId('span-x');
    const y = h.freshConvoId('span-y');
    answers('SPAN-');
    const other = await h.connect();
    const release = holdLocks(x, y);
    const since = client.messages.length;
    let early;
    try {
      send(client, x, 'SPAN-1 see this', [file('shot.png', png())]);
      send(client, y, 'SPAN-2 see this', [file('shot.png', png())]);
      await allTaken(client);
      send(other, y, 'SPAN-3 see this', [file('shot.png', png())]);
      send(other, x, 'SPAN-4 see this', [file('shot.png', png())]);
      await allTaken(other);
      send(other, y, 'SPAN-5 see this', [file('shot.png', png())]);
      await arrived((m) => m.type === 'chat_refused', { on: other });
      await h.delay(300);
      early = [answersOf(client, x, since), answersOf(client, y, since), answersOf(other, x, 0), answersOf(other, y, 0)]
        .map((list) => list.map((m) => m.code || m.type));
    } finally {
      await release();
    }
    assert.deepStrictEqual(early, [[], [], [], ['busy']], 'the fifth, on the second socket, is refused busy while the four wait');
    assert.ok(await h.waitUntil(() => storedOf(x, since).length + storedOf(y, since).length + storedOf(x, 0, other).length
      + storedOf(y, 0, other).length === 4), 'the four are stored once released');
    assert.deepStrictEqual([entriesOf(x).length, entriesOf(y).length], [2, 2], 'two entries in each conversation');
    assert.deepStrictEqual(promptsWith('SPAN-5'), [], 'and the fifth is never dispatched');
    other.close();
    h.reapConvo(x);
    h.reapConvo(y);
  });

  test('a place is free again after a refused payload and after a stored message', async () => {
    const id = h.freshConvoId('cap-free');
    answers('FREE-');
    const first = client.messages.length;
    for (let n = 0; n < 4; n++) chat(id, 'FREE-0 not files', 'not a list');
    assert.ok(await h.waitUntil(() => answersOf(client, id, first).length === 4), 'four payloads are answered');
    assert.deepStrictEqual(answersOf(client, id, first).map((m) => m.code), ['bad-payload', 'bad-payload', 'bad-payload', 'bad-payload']);
    for (const after of ['refused payloads', 'stored messages']) {
      const release = holdLocks(id);
      const since = client.messages.length;
      let early;
      try {
        for (let n = 1; n <= 5; n++) chat(id, `FREE-${n} see this`, [file('shot.png', png())]);
        await arrived((m) => m.type === 'chat_refused' && m.conversationId === id, { since });
        await h.delay(300);
        early = answersOf(client, id, since).map((m) => m.code);
      } finally {
        await release();
      }
      assert.deepStrictEqual(early, ['busy'], `after four ${after}, four places are free and only the fifth is refused`);
      assert.ok(await h.waitUntil(() => storedOf(id, since).length === 4), `after four ${after}, the four are stored`);
    }
    h.reapConvo(id);
  });

  test('a payload refused behind its conversation\'s earlier files keeps its place until its refusal is sent', async () => {
    const id = h.freshConvoId('cap-behind');
    const elsewhere = h.freshConvoId('cap-elsewhere');
    answers('BEHIND-');
    const release = holdLocks(id);
    const since = client.messages.length;
    let early;
    try {
      chat(id, 'BEHIND-1 see this', [file('shot.png', png())]);
      for (let n = 2; n <= 4; n++) chat(id, `BEHIND-${n} not files`, 'not a list');
      chat(elsewhere, 'BEHIND-5 see this', [file('shot.png', png())]);
      await arrived((m) => m.type === 'chat_refused' && m.conversationId === elsewhere, { since });
      await h.delay(300);
      early = [answersOf(client, id, since), answersOf(client, elsewhere, since)].map((list) => list.map((m) => m.code || m.type));
    } finally {
      await release();
    }
    assert.deepStrictEqual(early, [[], ['busy']],
      'the three refused payloads wait behind the files before them, still in hand, so another conversation\'s message is refused busy');
    assert.ok(await h.waitUntil(() => answersOf(client, id, since).length === 4), 'once released, each is answered');
    assert.deepStrictEqual(answersOf(client, id, since).map((m) => m.code || m.type), ['chat_stored', 'bad-payload', 'bad-payload', 'bad-payload'],
      'in the order they arrived');
    assert.deepStrictEqual([entriesOf(elsewhere), listing(folderOf(elsewhere))], [[], null], 'nothing is written for the busy one');
    assert.ok(await resultFor(id, 'DONE-BEHIND-', since), 'and the stored one is dispatched');
    h.reapConvo(id);
    h.reapConvo(elsewhere);
  });
});

describe('deleting a conversation deletes its attachments, and says when it could not', () => {
  const kept = (id) => [{ type: 'conversation_files_kept', id,
    text: `Rundock deleted the conversation but couldn't remove its attached files. They're still in .rundock/attachments/${id}/.` }];
  const deletedList = () => path.join(attachmentsDir(), 'deleted.json');
  const listed = () => JSON.parse(fs.readFileSync(deletedList(), 'utf-8'));
  const inList = (id) => h.internal.readConversations().some((c) => c.id === id);
  const transcriptOf = (id) => path.join(h.workspaceDir, '.rundock', 'transcripts', `${id}.json`);
  const contents = (dir) => Object.fromEntries((listing(dir) || []).map((n) => [n, sha256(fs.readFileSync(path.join(dir, n)))]));

  // Sends the delete; once conversation_deleted has arrived and anything after
  // it has had time to, returns the notices that came with it.
  async function deleting(id) {
    const since = client.messages.length;
    client.send({ type: 'delete_conversation', id });
    assert.ok(await arrived((m) => m.type === 'conversation_deleted' && m.id === id, { since }), 'conversation_deleted is sent');
    await h.delay(200);
    return client.messages.slice(since).filter((m) => m.type === 'conversation_files_kept');
  }

  // A conversation in the list whose one message stored a file.
  async function withFiles(prefix) {
    const id = h.freshConvoId(prefix);
    answers('ASK-DEL');
    const since = client.messages.length;
    chat(id, 'ASK-DEL see this', [file('Screen Shot.png', png())]);
    assert.ok(await storedFor(id, since) && await resultFor(id, 'DONE-ASK-DEL', since), 'the conversation holds a message\'s files');
    h.reapConvo(id);
    seed(id, { agentId: 'chief-of-staff' });
    return id;
  }

  // Runs `fn` with deleted.json holding `text`, then puts it back.
  async function withDeletedList(text, fn) {
    fs.mkdirSync(attachmentsDir(), { recursive: true });
    const was = fs.existsSync(deletedList()) ? fs.readFileSync(deletedList()) : null;
    fs.writeFileSync(deletedList(), text);
    try { await fn(); } finally { if (was) fs.writeFileSync(deletedList(), was); else fs.rmSync(deletedList(), { force: true }); }
  }

  // Runs `fn` with the attachments folder moved aside, then puts it back.
  async function withoutAttachments(fn) {
    fs.mkdirSync(attachmentsDir(), { recursive: true });
    const aside = `${attachmentsDir()}-aside`;
    fs.renameSync(attachmentsDir(), aside);
    try { await fn(); } finally { fs.rmSync(attachmentsDir(), { recursive: true, force: true }); fs.renameSync(aside, attachmentsDir()); }
  }

  test('a conversation with a message\'s files: the folder goes, the ID is listed, the transcript stays, and no notice', async () => {
    const id = await withFiles('del-ok');
    assert.ok(fs.existsSync(transcriptOf(id)));
    assert.deepStrictEqual(await deleting(id), []);
    assert.strictEqual(listing(folderOf(id)), null, 'the folder is gone');
    assert.ok(listed().includes(id), 'the ID is in deleted.json');
    assert.ok(fs.existsSync(transcriptOf(id)), 'the transcript is kept');
    assert.ok(!inList(id), 'the conversation is gone from the list');
  });

  for (const junk of ['not json', '{}']) {
    test(`a deleted list holding ${junk}: the conversation goes, its files stay, and the notice says where`, async () => {
      const id = await withFiles('del-junk');
      const before = contents(folderOf(id));
      await withDeletedList(junk, async () => {
        assert.deepStrictEqual(await deleting(id), kept(id));
        assert.deepStrictEqual(contents(folderOf(id)), before, 'the folder and its files as they were');
        assert.ok(!inList(id), 'the conversation is gone from the list');
      });
    });
  }

  for (const junk of ['not json', '{}']) {
    test(`a deleted list holding ${junk}, and no folder: the conversation goes, and no notice`, async () => {
      const id = h.freshConvoId('del-none');
      seed(id, { agentId: 'chief-of-staff' });
      await withDeletedList(junk, async () => {
        // The list refuses the conversation's files, which is why it has no folder.
        await refusedWith({ type: 'chat', conversationId: id, agent: 'chief-of-staff', content: 'ASK-JUNK see this', attachments: [file('Screen Shot.png', png())] },
          { code: 'save-failed', title: 'Message not sent', text: FALLBACK });
        assert.strictEqual(listing(folderOf(id)), null, 'no folder');
        assert.deepStrictEqual(await deleting(id), []);
        assert.ok(!inList(id), 'the conversation is gone from the list');
      });
    });
  }

  test('a link at attachments: the notice, and the link\'s target as it was', { skip: process.platform === 'win32' && 'links need privileges on Windows' }, async () => {
    const id = h.freshConvoId('del-link');
    seed(id, { agentId: 'chief-of-staff' });
    const outside = makeTempDir('outside-');
    fs.mkdirSync(path.join(outside, id));
    fs.writeFileSync(path.join(outside, id, 'notes.txt'), 'hello');
    await withoutAttachments(async () => {
      fs.symlinkSync(outside, attachmentsDir());
      try {
        assert.deepStrictEqual(await deleting(id), kept(id));
      } finally {
        fs.unlinkSync(attachmentsDir());
      }
    });
    assert.deepStrictEqual([listing(outside), listing(path.join(outside, id))], [[id], ['notes.txt']], 'nothing written or removed there');
    assert.strictEqual(fs.readFileSync(path.join(outside, id, 'notes.txt'), 'utf-8'), 'hello');
    assert.ok(!inList(id), 'the conversation is gone from the list');
  });

  test('an ID of ../..: conversation_deleted, no notice, and nothing created or written', async () => {
    await withoutAttachments(async () => {
      // The same ID is refused as a message's files' conversation, and creates nothing there either.
      const since = client.messages.length;
      client.send({ type: 'chat', conversationId: '../..', agent: 'chief-of-staff', content: 'ASK-UP see this', attachments: [file('Screen Shot.png', png())] });
      const refused = await arrived((m) => m.type === 'chat_refused', { since });
      assert.deepStrictEqual(refused && [refused.conversationId, refused.code], ['../..', 'bad-id'], 'the files are refused bad-id');
      assert.strictEqual(listing(attachmentsDir()), null, 'and no attachments folder is created');
      assert.deepStrictEqual(await deleting('../..'), []);
      assert.strictEqual(listing(attachmentsDir()), null, 'no attachments folder is created');
      for (const dir of [path.join(h.workspaceDir, '.rundock'), h.workspaceDir, path.dirname(h.workspaceDir)]) {
        assert.ok(!fs.existsSync(path.join(dir, 'deleted.json')), `no deleted.json in ${path.basename(dir)}`);
      }
    });
  });

  test('a chat with files in flight when the delete arrives is stored, then deleted with the conversation, and no notice', async () => {
    const id = h.freshConvoId('del-flight');
    seed(id, { agentId: 'chief-of-staff' });
    answers('ASK-FLIGHT');
    let release;
    const held = store.withConversationLock(id, () => new Promise((resolve) => { release = resolve; }));
    const since = client.messages.length;
    chat(id, 'ASK-FLIGHT see this', [file('Screen Shot.png', png())]);
    client.send({ type: 'delete_conversation', id });
    await h.delay(200);
    release();
    await held;
    assert.ok(await arrived((m) => m.type === 'conversation_deleted' && m.id === id, { since }), 'conversation_deleted is sent');
    assert.ok(await storedFor(id, since), 'the chat is stored');
    // The delete takes the lock straight after the write, so the entry is gone
    // by the time the stored message comes back into the handler, and its
    // reference is refused rather than dispatched.
    assert.ok(await arrived((m) => m.type === 'chat_refused' && m.conversationId === id, { since }), 'the stored message is answered');
    await h.delay(300);
    const answered = client.messages.slice(since);
    assert.deepStrictEqual(answered.filter((m) => m.type === 'chat_refused').map((m) => m.code), ['bad-entry'],
      'the files are not refused, and the message naming the deleted entry is refused once');
    assert.deepStrictEqual([spawnsFor(id).length, promptsWith('ASK-FLIGHT').length], [0, 0], 'and reaches no process');
    assert.ok(!answered.some((m) => m.type === 'conversation_files_kept'), 'no notice');
    assert.strictEqual(listing(folderOf(id)), null, 'the folder is gone');
    h.reapConvo(id);
  });

  test('a chat with files sent after the delete is refused, and recreates nothing', async () => {
    const id = await withFiles('del-after');
    assert.deepStrictEqual(await deleting(id), []);
    await refusedWith({ type: 'chat', conversationId: id, agent: 'chief-of-staff', content: 'ASK-DEL again', attachments: [file('notes.txt', Buffer.from('hello'))] },
      { code: 'deleted', title: 'Message not sent', text: 'This conversation was deleted in another window.' });
    assert.strictEqual(listing(folderOf(id)), null, 'nothing recreated');
  });

  test('a delete whose answer cannot be sent ends in the log, never in a rejection', async () => {
    const id = h.freshConvoId('del-throw');
    seed(id, { agentId: 'chief-of-staff' });
    const logged = [];
    const error = console.error;
    console.error = (...args) => { logged.push(args.map(String).join(' ')); };
    try {
      await assert.doesNotReject(async () => handleDeleteConversation(h.internal.wsHandlerContext, { send() { throw new Error('socket gone'); } }, { id }));
    } finally {
      console.error = error;
    }
    assert.ok(logged.some((line) => line.includes('socket gone')), 'the failure is logged');
    assert.ok(!inList(id), 'the conversation is gone from the list');
  });
});

describe('after every test above', () => {
  test('no receive ended in an unhandled rejection', () => {
    const answered = new Set(client.messages.map((m) => m.type));
    assert.ok(answered.has('chat_stored') && answered.has('chat_refused'), 'messages with files were stored and refused above');
    assert.deepStrictEqual(rejections, []);
  });
});
