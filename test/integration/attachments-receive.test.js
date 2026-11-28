'use strict';
// Integration: a chat message's attachments through the real server.
//
// A message with files is stored once, with its record entry, before it goes
// any further, and from there it carries the stored text, never the file data:
// into the transcript row, the runtime's prompt, the runtime's own session
// file and the history a reload reads. A refused message is answered with one
// chat_refused and writes, records, appends and dispatches nothing. Files for
// a Codex agent are refused before anything is decoded. A frame over the limit
// closes only its own socket. A conversation's delete removes its files once
// the messages with files already on their way are through, and says so when
// it couldn't.
//
// Every wait is h.waitUntil, which returns false on timeout, followed by an
// assertion, so a server that ignores attachments fails here on an assertion.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { isDeepStrictEqual } = require('node:util');

const h = require('../helpers/harness.js');
const store = require('../../lib/attachments/store.js');
const { agentFile, standardTeam, makeTempDir } = require('../helpers/workspace.js');
const { makeWorkspace } = require('../helpers/workspace.js');
const { handleDeleteConversation } = require('../../lib/protocol/handlers/conversations.js');

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
// Each turn read for a message whose text holds `tag`, as the stdin line
// carried it: a string, or an array for a message with images or PDFs.
const turnsWith = (tag) => h.readPrompts().filter((p) => p.prompt.includes(tag)).map((p) => JSON.parse(p.line).message.content);
// The turn a message stored with `sent` is handed over as: the stored text,
// then a block for each image and PDF, of the bytes sent.
function withBlocks(stored, sent) {
  return [{ type: 'text', text: stored.content }, ...sent.map((f) => (/\.pdf$/i.test(f.name)
    ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: f.data } }
    : { type: 'image', source: { type: 'base64', media_type: 'image/png', data: f.data } }))];
}
// The stored name a line gives: what follows its last slash, up to its label.
const nameIn = (line) => line.slice(line.lastIndexOf('/') + 1, line.indexOf(' ('));

// The stub's script, with the sessions it refuses to resume.
function scenario(rules, deadSessions = [], extra = {}) {
  fs.writeFileSync(path.join(h.workspaceDir, 'stub-scenario.json'), JSON.stringify({ ...extra, rules, deadSessions }));
}
// A listed conversation whose stored session `sessionId` the stub refuses.
function seed(id, sessionId) {
  const all = h.internal.readConversations().filter((c) => c.id !== id);
  h.internal.writeConversations([{ id, title: id, status: 'active', agentId: 'chief-of-staff', sessionId,
    sessionIds: [{ agentId: 'chief-of-staff', sessionId }] }, ...all]);
}
const spawnsFor = (id) => h.readInvocations().filter((i) => i.env && i.env.RUNDOCK_CONVO_ID === id);
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
const storedFiles = () => [file('Screen Shot.png', png()), file('Incident-Report-22-Nov.pdf', pdf())];
async function storedMessage(tag) {
  const id = h.freshConvoId(tag.toLowerCase());
  answers([tag], { keepSession: true });
  const since = client.messages.length;
  chat(id, `${tag} see these`, storedFiles());
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
    assert.deepStrictEqual(turnsWith('ASK-PROMPT'), [withBlocks(stored, storedFiles())],
      'one turn: the whole stored text, then a block for the PNG and one for the PDF');
    h.reapConvo(id);
  });

  test('the runtime\'s session file for the turn holds a user message with the whole stored text', async () => {
    const { id, stored, sessionId } = await storedMessage('ASK-SESSION');
    const project = fs.realpathSync(h.workspaceDir).replace(/[^a-zA-Z0-9]/g, '-');
    const at = path.join(process.env.HOME, '.claude', 'projects', project, `${sessionId}.jsonl`);
    assert.ok(fs.existsSync(at), `the session file is at ${at}`);
    const user = h.readAppendedLog(at).filter((l) => l.type === 'user');
    assert.ok(user.some((l) => isDeepStrictEqual(l.message.content, withBlocks(stored, storedFiles()))),
      'a user message holds the whole stored text, then its blocks, as the array it was sent');
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

// A conversation mid-transition, its messages queued as the kill window
// queues them.
function transition(id) {
  const t = { state: 'killing', owner: {}, queued: [], failsafe: setTimeout(() => {}, 30000) };
  h.internal.convoTransitions.set(id, t);
  return t;
}
const endTransition = (id) => h.internal.wsHandlerContext.transitions.endConvoTransition(id);
// What endConvoTransition does, done by hand: the entry deleted, then each
// queued message emitted on a connected server socket.
function replayByHand(id) {
  const t = h.internal.convoTransitions.get(id);
  clearTimeout(t.failsafe);
  h.internal.convoTransitions.delete(id);
  const sock = [...h.internal.connectedClients].find((c) => c.readyState === 1);
  for (const queued of t.queued) sock.emit('message', JSON.stringify(queued));
}
function leaveTransition(id, t) {
  if (h.internal.convoTransitions.get(id) === t) endTransition(id);
}
const expired = (id, since) => arrived((m) => m.subtype === 'session_expired' && m._conversationId === id, { since, timeout: 15000 });

// The record changed after the message was stored and before the server sent
// it back into the handler: its entry taken out, or the record unreadable.
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
const BAD_ENTRY = ['bad-entry', NOT_SENT, FALLBACK];

describe('every path back into the handler writes once and records once', () => {
  for (const [how, replay, tag] of [['endConvoTransition', endTransition, 'ASK-BUFE'], ['hand', replayByHand, 'ASK-BUFH']]) {
    test(`the transition buffer queues the stored message, and its replay by ${how} writes nothing more`, async () => {
      const id = h.freshConvoId('buffered');
      answers([tag]);
      const sent = [file('Screen Shot.png', png()), file('Incident-Report-22-Nov.pdf', pdf())];
      const t = transition(id);
      try {
        const since = client.messages.length;
        chat(id, `${tag} see these`, sent);
        assert.ok(await h.waitUntil(() => t.queued.length > 0), 'the message is queued');
        const record = entriesOf(id) || [];
        assert.strictEqual(record.length, 1, 'the record holds the entry before the message is queued');
        assert.strictEqual(record[0].id, t.queued[0].attachmentEntry);
        assert.deepStrictEqual(record[0].files.map((f) => f.sha256), sent.map((f) => sha256(decoded(f))));
        const queue = JSON.stringify(t.queued);
        assert.ok(!queue.includes('"attachments"'), 'the queue holds no attachments');
        for (const f of sent) assert.ok(!queue.includes(f.data), 'and none of the data sent');
        const stored = await storedFor(id, since);
        assert.ok(stored, 'the message is answered with chat_stored');
        replay(id);
        assert.ok(await resultFor(id, `DONE-${tag}`, since), 'the replay is dispatched');
        assert.deepStrictEqual(turnsWith(tag), [withBlocks(stored, sent)], 'once, with the stored text and its blocks');
        writtenOnce(id, [stored]);
      } finally {
        leaveTransition(id, t);
        h.reapConvo(id);
      }
    });
  }

  for (const legacy of [false, true]) {
    test(`the ${legacy ? 'legacy' : 'interactive'} resume retry carries the stored text and writes nothing again`, async () => {
      const id = h.freshConvoId(legacy ? 'retry-legacy' : 'retry');
      const dead = legacy ? 'dead-orch-ff' : 'dead-orch-ee';
      seed(id, dead);
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
      const prompts = h.readPrompts().filter((p) => p.prompt.includes('ASK-RETRY'));
      // The stub reads no stdin for a resume it refuses, so only the fresh
      // start's prompt is logged.
      assert.deepStrictEqual(prompts.map((p) => [p.resume || null, JSON.parse(p.line).message.content]),
        [[null, withBlocks(stored, [file('Screen Shot.png', png())])]], 'the fresh start is sent the stored text and its block once');
      writtenOnce(id, [stored]);
      h.reapConvo(id);
    });
  }

  test('a second message with files, sent while the refused resume is still starting, is stored once and follows the first', async () => {
    const id = h.freshConvoId('carried');
    seed(id, 'dead-orch-s');
    scenario([
      { match: { promptIncludes: 'FIRST-S' }, turn: [{ text: 'DONE-FIRST-S' }] },
      { match: { promptIncludes: 'SECOND-S' }, turn: [{ text: 'DONE-SECOND-S' }] },
    ], ['dead-orch-s'], { refusalExitMs: 1200 });
    h.clearInvocations();
    const since = client.messages.length;
    chat(id, 'FIRST-S hello', [file('Screen Shot.png', png())], { sessionId: 'dead-orch-s' });
    const first = await storedFor(id, since);
    assert.ok(first, 'the first is answered with chat_stored');
    assert.ok(await expired(id, since), 'the resume is refused and still lingering');
    const mid = client.messages.length;
    chat(id, 'SECOND-S and this', [file('notes.txt', Buffer.from('hello'))]);
    const second = await storedFor(id, mid);
    assert.ok(second, 'the second is answered with chat_stored');
    assert.ok(await resultFor(id, 'DONE-SECOND-S', since), 'the second is answered');
    assert.deepStrictEqual(spawnsFor(id).map((i) => i.resume), ['dead-orch-s', null], 'one fresh start carries both');
    const fresh = h.readPrompts().filter((p) => !p.resume && p.prompt.includes('-S '));
    assert.deepStrictEqual(fresh.map((p) => p.prompt), [first.content, second.content], 'each text reaches the fresh process once, in order');
    writtenOnce(id, [first, second]);
    h.reapConvo(id);
  });

  for (const [how, label] of BROKEN) {
    test(`the transition buffer's replay is refused when its entry is ${label}, and reaches no process`, async () => {
      const id = h.freshConvoId('buffered-broken');
      answers(['ASK-BUFBROKEN']);
      const t = transition(id);
      try {
        const since = client.messages.length;
        chat(id, 'ASK-BUFBROKEN see this', [file('Screen Shot.png', png())]);
        const stored = await storedFor(id, since);
        assert.ok(stored, 'the message is answered with chat_stored');
        assert.ok(await h.waitUntil(() => t.queued.length > 0), 'and queued');
        breakRecord(id, stored.entry.id, how);
        const replay = client.messages.length;
        endTransition(id);
        assert.deepStrictEqual(await refusedOnReentry(id, replay), [BAD_ENTRY], 'one bad-entry refusal');
        assert.deepStrictEqual(userRows(id), [], 'no transcript row');
        assert.deepStrictEqual(spawnsFor(id), [], 'no process started');
        assert.deepStrictEqual(promptsWith('ASK-BUFBROKEN'), [], 'nothing written to a stdin');
      } finally {
        leaveTransition(id, t);
        h.reapConvo(id);
      }
    });
  }

  for (const legacy of [false, true]) {
    for (const [how, label] of BROKEN) {
      test(`the ${legacy ? 'legacy' : 'interactive'} resume retry is refused when its entry is ${label}, and reaches no process`, async () => {
        const id = h.freshConvoId(legacy ? 'retry-legacy-broken' : 'retry-broken');
        const dead = `dead-broken-${legacy ? 'legacy' : 'interactive'}-${how}`;
        seed(id, dead);
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
          assert.ok(await expired(id, since), 'the resume is refused and still lingering');
          assert.strictEqual(spawnsFor(id).length, 1, 'and not yet retried');
          breakRecord(id, stored.entry.id, how);
          refusals = await refusedOnReentry(id, since);
        } finally {
          delete process.env.RUNDOCK_LEGACY_SPAWN;
        }
        assert.deepStrictEqual(refusals, [BAD_ENTRY], 'one bad-entry refusal');
        assert.deepStrictEqual(spawnsFor(id).map((i) => i.resume), [dead], 'the refused resume, and no fresh start');
        assert.deepStrictEqual(h.readPrompts().filter((p) => !p.resume && p.prompt.includes('ASK-RETRYBROKEN')), [], 'nothing written to a fresh stdin');
        assert.deepStrictEqual(userRows(id).map((r) => r.text), [stored.content], 'the first pass\'s row, and none for the retry');
        h.reapConvo(id);
      });
    }
  }

  // The retry carries the first message's reference and the message carried
  // after it its own, so each is checked against the record as it is: with
  // only the first's entry gone, the second still goes, alone, to a fresh
  // start; with the record unreadable, neither does.
  for (const [how, label] of BROKEN) {
    const secondGoes = how === 'removed';
    test(`the carried loop refuses the first message when its entry is ${label}, and ${secondGoes ? 'the second goes on with its own' : 'neither reaches a process'}`, async () => {
      const id = h.freshConvoId('carried-broken');
      const dead = `dead-broken-carried-${how}`;
      seed(id, dead);
      scenario([
        { match: { promptIncludes: 'FIRST-CB' }, turn: [{ text: 'DONE-FIRST-CB' }] },
        { match: { promptIncludes: 'SECOND-CB' }, turn: [{ text: 'DONE-SECOND-CB' }] },
      ], [dead], { refusalExitMs: 2000 });
      h.clearInvocations();
      const since = client.messages.length;
      chat(id, 'FIRST-CB hello', [file('Screen Shot.png', png())], { sessionId: dead });
      const first = await storedFor(id, since);
      assert.ok(first, 'the first is answered with chat_stored');
      assert.ok(await expired(id, since), 'the resume is refused and still lingering');
      const mid = client.messages.length;
      chat(id, 'SECOND-CB and this', [file('notes.txt', Buffer.from('hello'))]);
      const second = await storedFor(id, mid);
      assert.ok(second, 'the second is answered with chat_stored');
      assert.ok(await h.waitUntil(() => userRows(id).length === 2), 'and reaches the refused process');
      assert.strictEqual(spawnsFor(id).length, 1, 'which is not yet retried');
      breakRecord(id, first.entry.id, how);
      assert.deepStrictEqual(await refusedOnReentry(id, mid), secondGoes ? [BAD_ENTRY] : [BAD_ENTRY, BAD_ENTRY],
        secondGoes ? 'one bad-entry refusal, for the first' : 'one bad-entry refusal for each re-entry');
      if (secondGoes) assert.ok(await resultFor(id, 'DONE-SECOND-CB', mid), 'the second is answered');
      assert.deepStrictEqual(spawnsFor(id).map((i) => i.resume), secondGoes ? [dead, null] : [dead],
        secondGoes ? 'the refused resume, then a fresh start for the second' : 'the refused resume, and no fresh start');
      assert.deepStrictEqual(h.readPrompts().filter((p) => !p.resume && p.prompt.includes('-CB ')).map((p) => p.prompt), secondGoes ? [second.content] : [],
        secondGoes ? 'the second alone written to a fresh stdin' : 'nothing written to a fresh stdin');
      assert.deepStrictEqual(userRows(id).map((r) => r.text), [first.content, second.content], 'the first pass\'s rows, and none for the retry');
      h.reapConvo(id);
    });
  }

  describe('a reference to a record entry, without files', () => {
    const mine = h.freshConvoId('ref-own');
    const other = h.freshConvoId('ref-other');
    const broken = h.freshConvoId('ref-broken');
    const stored = {};

    // Asserts nothing, so each test below checks what it was given itself.
    before(async () => {
      answers(['ASK-REF', 'REF-OK']);
      for (const id of [mine, other]) {
        const since = client.messages.length;
        chat(id, 'ASK-REF see this', [file('Screen Shot.png', png())]);
        stored[id] = await storedFor(id, since);
        await resultFor(id, 'DONE-ASK-REF', since);
      }
      fs.mkdirSync(folderOf(broken), { recursive: true });
      fs.writeFileSync(path.join(folderOf(broken), 'record.json'), 'not json');
    });
    after(() => { h.reapConvo(mine); h.reapConvo(other); });
    const holds = (id) => {
      assert.ok(stored[id], `${id}'s message with files is answered with chat_stored`);
      assert.deepStrictEqual(entriesOf(id), [stored[id].entry], `${id} holds the entry its message stored`);
    };

    test('naming an entry of its own conversation is dispatched and writes nothing', async () => {
      holds(mine);
      const since = client.messages.length;
      chat(mine, 'REF-OK again', undefined, { attachmentEntry: stored[mine].entry.id });
      assert.ok(await resultFor(mine, 'DONE-REF-OK', since), 'the message is dispatched');
      assert.deepStrictEqual(entriesOf(mine), [stored[mine].entry]);
      assert.deepStrictEqual(listing(folderOf(mine)), [...stored[mine].entry.files.map((f) => f.file), 'record.json'].sort());
      assert.ok(!client.messages.slice(since).some((m) => m.type === 'chat_refused' || m.type === 'chat_stored'), 'with no attachment answer');
    });

    const cases = [
      ['an unknown entry', () => { holds(mine); return [mine, 'no-such-entry']; }],
      ['a number', () => { holds(mine); return [mine, 42]; }],
      ['another conversation\'s entry', () => { holds(mine); holds(other); return [mine, stored[other].entry.id]; }],
      ['an entry of an unreadable record', () => {
        assert.throws(() => store.readRecord(h.workspaceDir, broken), { code: 'record-unreadable' }, 'its record does not parse');
        return [broken, 'any-entry'];
      }],
    ];
    for (const [label, pick] of cases) {
      test(`naming ${label} is refused`, async () => {
        const [id, attachmentEntry] = pick();
        await refusedWith({ type: 'chat', conversationId: id, agent: 'chief-of-staff', content: 'ASK-REF forged', attachmentEntry },
          { code: 'bad-entry', title: NOT_SENT, text: FALLBACK });
      });
    }
  });

  test('a later chat waits for the files before it, and another conversation does not', async () => {
    const id = h.freshConvoId('held');
    const elsewhere = h.freshConvoId('not-held');
    answers(['HELD-A', 'HELD-B', 'HELD-C']);
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
    assert.deepStrictEqual(h.readPrompts().filter((p) => /HELD-[ABX]/.test(p.prompt)).map((p) => JSON.parse(p.line).message.content),
      [withBlocks(stored, [file('Screen Shot.png', png())]), 'HELD-B and then'], 'in the order sent, and nothing forged');
    h.reapConvo(id);
    h.reapConvo(elsewhere);
  });
});

describe('deleting a conversation deletes its attachments, and says when it could not', () => {
  const kept = (id) => [{ type: 'conversation_files_kept', id,
    text: `Rundock deleted the conversation but couldn't remove its attached files. They're still in .rundock/attachments/${id}/.` }];
  const deletedList = () => path.join(attachmentsDir(), 'deleted.json');
  const inList = (id) => h.internal.readConversations().some((c) => c.id === id);
  const transcriptOf = (id) => path.join(h.workspaceDir, '.rundock', 'transcripts', `${id}.json`);
  const list = (id) => h.internal.writeConversations([{ id, title: id, status: 'active', agentId: 'chief-of-staff' },
    ...h.internal.readConversations().filter((c) => c.id !== id)]);

  // Sends the delete; once conversation_deleted has arrived and anything after
  // it has had time to, returns the notices that came with it.
  async function deleting(id) {
    const since = client.messages.length;
    client.send({ type: 'delete_conversation', id });
    assert.ok(await arrived((m) => m.type === 'conversation_deleted' && m.id === id, { since }), 'conversation_deleted is sent');
    await h.delay(200);
    return client.messages.slice(since).filter((m) => m.type === 'conversation_files_kept');
  }

  // A listed conversation whose one message stored a file, its turn ended.
  async function withFiles(prefix) {
    const id = h.freshConvoId(prefix);
    answers(['ASK-DEL']);
    const since = client.messages.length;
    chat(id, 'ASK-DEL see this', [file('Screen Shot.png', png())]);
    assert.ok(await storedFor(id, since) && await resultFor(id, 'DONE-ASK-DEL', since), 'the conversation holds a message\'s files');
    h.reapConvo(id);
    list(id);
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
    assert.ok(await h.waitUntil(() => fs.existsSync(transcriptOf(id))), 'the conversation has a transcript');
    assert.deepStrictEqual(await deleting(id), []);
    assert.strictEqual(listing(folderOf(id)), null, 'the folder is gone');
    assert.ok(JSON.parse(fs.readFileSync(deletedList(), 'utf-8')).includes(id), 'the ID is in deleted.json');
    assert.ok(fs.existsSync(transcriptOf(id)), 'the transcript is kept');
    assert.ok(!inList(id), 'the conversation is gone from the list');
  });

  for (const junk of ['not json', '{}']) {
    test(`a deleted list holding ${junk}: the conversation goes, its files stay, and the notice says where`, async () => {
      const id = await withFiles('del-junk');
      const before = bytesIn(folderOf(id));
      await withDeletedList(junk, async () => {
        assert.deepStrictEqual(await deleting(id), kept(id));
        assert.deepStrictEqual(bytesIn(folderOf(id)), before, 'the folder and its files as they were');
        assert.ok(!inList(id), 'the conversation is gone from the list');
      });
    });

    test(`a deleted list holding ${junk}, and no folder: the conversation goes, and no notice`, async () => {
      const id = h.freshConvoId('del-none');
      list(id);
      await withDeletedList(junk, async () => {
        assert.strictEqual(listing(folderOf(id)), null, 'no folder');
        assert.deepStrictEqual(await deleting(id), []);
        assert.ok(!inList(id), 'the conversation is gone from the list');
      });
    });
  }

  test('a link at attachments: the notice, and the link\'s target as it was', { skip: process.platform === 'win32' && 'links need privileges on Windows' }, async () => {
    const id = h.freshConvoId('del-link');
    list(id);
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
      assert.deepStrictEqual(await deleting('../..'), []);
      assert.strictEqual(listing(attachmentsDir()), null, 'no attachments folder is created');
      for (const dir of [path.join(h.workspaceDir, '.rundock'), h.workspaceDir, path.dirname(h.workspaceDir)]) {
        assert.ok(!fs.existsSync(path.join(dir, 'deleted.json')), `no deleted.json in ${path.basename(dir)}`);
      }
    });
  });

  test('a chat with files on its way when the delete arrives is stored and dispatched once, then its folder goes, and no notice', async () => {
    const id = h.freshConvoId('del-flight');
    list(id);
    answers(['ASK-FLIGHT']);
    let release;
    const held = store.withConversationLock(id, () => new Promise((resolve) => { release = resolve; }));
    const since = client.messages.length;
    try {
      chat(id, 'ASK-FLIGHT see this', [file('Screen Shot.png', png())]);
      await h.delay(100);
      client.send({ type: 'delete_conversation', id });
      await h.delay(200);
      assert.ok(!client.messages.slice(since).some((m) => m.type === 'conversation_deleted'), 'the delete waits for the files');
    } finally {
      release();
      await held;
    }
    const stored = await storedFor(id, since);
    assert.ok(stored, 'the chat is answered with chat_stored');
    assert.ok(await arrived((m) => m.type === 'conversation_deleted' && m.id === id, { since }), 'conversation_deleted is sent');
    assert.strictEqual(listing(folderOf(id)), null, 'by then the folder is gone');
    assert.ok(await resultFor(id, 'DONE-ASK-FLIGHT', since), 'the message is answered by its run');
    const answered = client.messages.slice(since);
    assert.ok(!answered.some((m) => m.type === 'chat_refused'), 'no chat_refused');
    assert.deepStrictEqual(turnsWith('ASK-FLIGHT'), [withBlocks(stored, [file('Screen Shot.png', png())])], 'one turn, with the stored text and its block');
    assert.ok(!answered.some((m) => m.type === 'conversation_files_kept'), 'and no notice');
    h.reapConvo(id);
  });

  test('a stored message in the transition buffer, replayed after the delete, is refused bad-entry and reaches no process', async () => {
    const id = h.freshConvoId('del-buffer');
    list(id);
    answers(['ASK-DELBUF']);
    h.clearInvocations();
    const t = transition(id);
    try {
      const since = client.messages.length;
      chat(id, 'ASK-DELBUF see this', [file('Screen Shot.png', png())]);
      assert.ok(await storedFor(id, since), 'the message is answered with chat_stored');
      assert.ok(await h.waitUntil(() => t.queued.length > 0), 'and queued');
      assert.deepStrictEqual(await deleting(id), []);
      assert.strictEqual(listing(folderOf(id)), null, 'the folder is gone');
      const refusals = since;
      endTransition(id);
      assert.deepStrictEqual(await refusedOnReentry(id, refusals), [BAD_ENTRY], 'the replay is refused once');
      assert.deepStrictEqual([spawnsFor(id), promptsWith('ASK-DELBUF')], [[], []], 'and dispatched to no process');
    } finally {
      leaveTransition(id, t);
      h.reapConvo(id);
    }
  });

  test('a chat with files sent after the delete is refused, and recreates nothing', async () => {
    const id = await withFiles('del-after');
    assert.deepStrictEqual(await deleting(id), []);
    await refusedWith({ type: 'chat', conversationId: id, agent: 'chief-of-staff', content: 'ASK-DEL again', attachments: [file('notes.txt', Buffer.from('hello'))] },
      { code: 'deleted', title: NOT_SENT, text: 'This conversation was deleted in another window.' });
    assert.strictEqual(listing(folderOf(id)), null, 'nothing recreated');
  });

  test('a delete whose answer cannot be sent ends in the log, never in a rejection', async () => {
    const id = h.freshConvoId('del-throw');
    list(id);
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

// A switch of workspace arriving while a message's files are being written
// waits for that message, as a text chat already in the handler is finished
// where it arrived: stored, recorded and dispatched in the workspace that
// received it, and only then does the switch go ahead. One message is never
// answered chat_stored and then chat_refused.
describe('a workspace switch while files are on their way', () => {
  const transcriptIn = (dir, id) => {
    try { return JSON.parse(fs.readFileSync(path.join(dir, '.rundock', 'transcripts', `${id}.json`), 'utf-8')); } catch (e) { return null; }
  };
  const recordIn = (dir, id) => { try { return store.readRecord(dir, id).messages; } catch (e) { return null; } };
  // Back to the suite's own workspace, as the window chooses one.
  async function back() {
    const since = client.messages.length;
    client.send({ type: 'set_workspace', path: h.workspaceDir });
    const { msg } = await client.waitFor((m) => m.type === 'workspace_set' || m.type === 'workspace_error', { since, label: 'the switch back' });
    assert.strictEqual(msg.type, 'workspace_set', `the switch back failed: ${msg.message}`);
  }
  // Sends `request` while the first of `id`'s messages with files is held,
  // with a text chat behind it, and answers the messages that came back.
  async function switchWhileHeld(id, tag, request) {
    answers([tag]);
    let release;
    const held = store.withConversationLock(id, () => new Promise((resolve) => { release = resolve; }));
    const since = client.messages.length;
    try {
      chat(id, `${tag} see this`, [file('Screen Shot.png', png())]);
      chat(id, `${tag} and then`, undefined);
      await h.delay(100);
      client.send(request);
      await h.delay(200);
      assert.ok(!client.messages.slice(since).some((m) => m.type === 'workspace_set'), 'the switch waits for the files');
    } finally {
      release();
      await held;
    }
    const stored = await storedFor(id, since);
    const set = await arrived((m) => m.type === 'workspace_set' || m.type === 'workspace_error', { since });
    return { since, stored, set };
  }
  function finishedWhereReceived(id, tag, { since, stored, set }) {
    assert.ok(stored, 'the message is answered with chat_stored');
    assert.ok(set && set.type === 'workspace_set', 'the switch goes ahead');
    const answered = client.messages.slice(since);
    assert.ok(answered.indexOf(stored) < answered.indexOf(set), 'chat_stored comes before workspace_set');
    assert.ok(!answered.some((m) => m.type === 'chat_refused' && m.conversationId === id), 'and no chat_refused');
    assert.deepStrictEqual(recordIn(h.workspaceDir, id), [stored.entry], 'the record entry is in the workspace that received it');
    assert.deepStrictEqual((transcriptIn(h.workspaceDir, id) || []).filter((r) => r.role === 'user').map((r) => r.text),
      [stored.content, `${tag} and then`], 'its transcript there has the message, then the chat behind it');
    assert.strictEqual(listing(path.join(set.path, '.rundock', 'attachments', id)), null, 'the next workspace holds none of its files');
    assert.strictEqual(transcriptIn(set.path, id), null, 'nor its transcript');
  }

  test('set_workspace waits for the files, which are stored, recorded and dispatched in the first workspace; the next message goes to the second', async () => {
    const id = h.freshConvoId('switch-flight');
    const other = makeWorkspace({ claudeMd: '# Second fixture\n', agents: standardTeam() });
    try {
      const answered = await switchWhileHeld(id, 'ASK-SWITCH', { type: 'set_workspace', path: other });
      finishedWhereReceived(id, 'ASK-SWITCH', answered);
      assert.strictEqual(answered.set.path, other);
      const since = client.messages.length;
      chat(id, 'ASK-NEXT see this', [file('notes.txt', Buffer.from('hello'))]);
      const next = await storedFor(id, since);
      assert.ok(next, 'a message with files after the switch is stored');
      assert.deepStrictEqual(recordIn(other, id), [next.entry], 'in the second workspace');
      assert.deepStrictEqual(recordIn(h.workspaceDir, id), [answered.stored.entry], 'and the first keeps only its own');
    } finally {
      await back();
      h.reapConvo(id);
    }
  });

  test('create_workspace waits for the files the same way', async () => {
    const id = h.freshConvoId('create-flight');
    try {
      finishedWhereReceived(id, 'ASK-CREATE', await switchWhileHeld(id, 'ASK-CREATE', { type: 'create_workspace', name: `alpha ${id}` }));
    } finally {
      await back();
      h.reapConvo(id);
    }
  });

  test('with no files on their way, a switch answers at once', async () => {
    const other = makeWorkspace({ claudeMd: '# Third fixture\n', agents: standardTeam() });
    try {
      const since = client.messages.length;
      client.send({ type: 'set_workspace', path: other });
      const set = await arrived((m) => m.type === 'workspace_set' || m.type === 'workspace_error', { since, timeout: 2000 });
      assert.ok(set && set.type === 'workspace_set' && set.path === other);
    } finally {
      await back();
    }
  });
});

// A workspace switch arriving while a hand-over holds a conversation's chat
// waits for the hand-over to end and replay it, so the chat is recorded and
// dispatched in the workspace it was sent to; only then does the switch stop
// that workspace's processes and move the root. A hand-over holding nothing
// holds no switch, and none holds one past its failsafe.
describe('a workspace switch while a hand-over holds a message', () => {
  const transcriptIn = (dir, id) => {
    try { return JSON.parse(fs.readFileSync(path.join(dir, '.rundock', 'transcripts', `${id}.json`), 'utf-8')); } catch (e) { return null; }
  };
  const recordIn = (dir, id) => { try { return store.readRecord(dir, id).messages; } catch (e) { return null; } };
  const userRowsIn = (dir, id) => (transcriptIn(dir, id) || []).filter((r) => r.role === 'user').map((r) => r.text);
  const promptsIn = (dir, tag) => h.readAppendedLog(path.join(dir, 'stub-prompts.jsonl')).map((p) => p.prompt).filter((p) => p.includes(tag));
  const isAnswer = (m) => m.type === 'workspace_set' || m.type === 'workspace_error';
  const refusedFor = (id, since) => client.messages.slice(since).filter((m) => m.type === 'chat_refused' && m.conversationId === id);
  const second = (label) => makeWorkspace({ claudeMd: `# ${label} fixture\n`, agents: standardTeam() });

  // The switch's answer after `since`, with whether `id` was still in a
  // hand-over when it arrived; null when none arrives in time.
  async function answerAfter(id, since, timeout = 8000) {
    let held;
    const got = await client.waitFor((m) => {
      if (!isAnswer(m)) return false;
      held = h.internal.convoTransitions.has(id);
      return true;
    }, { since, timeout }).catch(() => null);
    return got && { set: got.msg, held };
  }
  // Back to the suite's own workspace, ending a hand-over the test left open
  // so a switch it still holds answers first.
  async function leave(id) {
    if (h.internal.convoTransitions.has(id)) endTransition(id);
    const since = client.messages.length;
    client.send({ type: 'set_workspace', path: h.workspaceDir });
    const { msg } = await client.waitFor((m) => (m.type === 'workspace_set' && m.path === h.workspaceDir) || m.type === 'workspace_error',
      { since, label: 'the switch back' });
    assert.strictEqual(msg.type, 'workspace_set', `the switch back failed: ${msg.message}`);
    h.reapConvo(id);
  }
  // Sends a chat with one file while `id` is in a hand-over, then `request`
  // once the message is stored and queued, and ends the hand-over.
  async function storedThenSwitched(id, tag, request) {
    answers([tag]);
    const t = transition(id);
    const since = client.messages.length;
    chat(id, `${tag} see this`, [file('Screen Shot.png', png())]);
    const stored = await storedFor(id, since);
    assert.ok(stored, 'the message is answered with chat_stored');
    assert.ok(await h.waitUntil(() => t.queued.length === 1), 'and queued by the hand-over');
    const asked = client.messages.length;
    client.send(request);
    await h.delay(200);
    assert.ok(!client.messages.slice(asked).some(isAnswer), 'no workspace_set while the hand-over holds the message');
    endTransition(id);
    const answered = await answerAfter(id, asked);
    assert.ok(answered && answered.set.type === 'workspace_set', 'the switch goes ahead once the hand-over ends');
    await h.delay(500);
    return { since, stored, set: answered.set };
  }
  function finishedInFirst(id, tag, { since, stored, set }) {
    const answered = client.messages.slice(since);
    assert.ok(answered.indexOf(stored) < answered.indexOf(set), 'chat_stored comes before workspace_set');
    assert.deepStrictEqual(refusedFor(id, since), [], 'and no chat_refused');
    assert.deepStrictEqual(recordIn(h.workspaceDir, id), [stored.entry], 'the record entry is in the first workspace');
    assert.deepStrictEqual(userRowsIn(h.workspaceDir, id), [stored.content], 'its transcript there has the message once');
    assert.strictEqual(listing(path.join(set.path, '.rundock', 'attachments', id)), null, 'the second workspace holds none of its files');
    assert.strictEqual(transcriptIn(set.path, id), null, 'nor its transcript');
    assert.deepStrictEqual(promptsIn(set.path, tag), [], 'nor a prompt with it');
  }

  test('set_workspace waits while a hand-over holds a stored message, which is recorded and dispatched in the first workspace', async () => {
    const id = h.freshConvoId('handover-set');
    const other = second('Fourth');
    try {
      const answered = await storedThenSwitched(id, 'ASK-HOSET', { type: 'set_workspace', path: other });
      assert.strictEqual(answered.set.path, other);
      finishedInFirst(id, 'ASK-HOSET', answered);
    } finally {
      await leave(id);
    }
  });

  test('create_workspace waits while a hand-over holds a stored message the same way', async () => {
    const id = h.freshConvoId('handover-create');
    try {
      finishedInFirst(id, 'ASK-HOCREATE', await storedThenSwitched(id, 'ASK-HOCREATE', { type: 'create_workspace', name: `alpha ${id}` }));
    } finally {
      await leave(id);
    }
  });

  test('set_workspace waits while a hand-over holds a text chat, whose row and prompt stay in the first workspace', async () => {
    const id = h.freshConvoId('handover-text');
    const other = second('Fifth');
    const text = 'ASK-HOTEXT just words';
    answers(['ASK-HOTEXT']);
    const t = transition(id);
    try {
      chat(id, text, undefined);
      assert.ok(await h.waitUntil(() => t.queued.length === 1), 'the chat is queued by the hand-over');
      const asked = client.messages.length;
      client.send({ type: 'set_workspace', path: other });
      await h.delay(200);
      assert.ok(!client.messages.slice(asked).some(isAnswer), 'no workspace_set while the hand-over holds the chat');
      endTransition(id);
      const answered = await answerAfter(id, asked);
      assert.ok(answered && answered.set.type === 'workspace_set' && answered.set.path === other, 'the switch goes ahead once the hand-over ends');
      assert.deepStrictEqual(userRowsIn(h.workspaceDir, id), [text], 'the first workspace\'s transcript has the chat once');
      assert.strictEqual(transcriptIn(other, id), null, 'the second has no transcript for the conversation');
      assert.deepStrictEqual(promptsIn(other, text), [], 'and no prompt with the chat');
    } finally {
      await leave(id);
    }
  });

  test('a switch that waited for files waits again while the hand-over holds them, with the chat behind them', async () => {
    const id = h.freshConvoId('handover-held');
    const other = second('Sixth');
    const tag = 'ASK-HOHELD';
    answers([tag]);
    const t = transition(id);
    try {
      let release;
      const held = store.withConversationLock(id, () => new Promise((resolve) => { release = resolve; }));
      const since = client.messages.length;
      try {
        chat(id, `${tag} see this`, [file('Screen Shot.png', png())]);
        chat(id, `${tag} and then`, undefined);
        await h.delay(100);
        client.send({ type: 'set_workspace', path: other });
        await h.delay(200);
        assert.ok(!client.messages.slice(since).some(isAnswer), 'the switch waits for the files');
      } finally {
        release();
        await held;
      }
      const stored = await storedFor(id, since);
      assert.ok(stored, 'the message is answered with chat_stored');
      assert.ok(await h.waitUntil(() => t.queued.length === 2), 'both messages are queued by the hand-over');
      await h.delay(200);
      assert.ok(!client.messages.slice(since).some(isAnswer), 'no workspace_set within 200 ms of chat_stored');
      endTransition(id);
      const answered = await answerAfter(id, since);
      assert.ok(answered && answered.set.type === 'workspace_set' && answered.set.path === other, 'the switch goes ahead once the hand-over ends');
      await h.delay(500);
      assert.deepStrictEqual(refusedFor(id, since), [], 'no chat_refused');
      assert.deepStrictEqual(userRowsIn(h.workspaceDir, id), [stored.content, `${tag} and then`],
        'the first workspace\'s transcript has the message, then the chat behind it');
      assert.strictEqual(listing(path.join(other, '.rundock', 'attachments', id)), null, 'the second workspace holds none of its files');
      assert.strictEqual(transcriptIn(other, id), null, 'nor its transcript');
      assert.deepStrictEqual(promptsIn(other, tag), [], 'nor a prompt with either');
    } finally {
      await leave(id);
    }
  });

  // One sequence, so the promise that an empty hand-over holds nothing is
  // tested beside the hold it is the exception to: first a hand-over holding a
  // chat holds a switch until it has replayed the chat, then a hand-over
  // holding nothing lets the next switch answer while it is still open.
  test('a hand-over holding a chat holds a switch until it replays the chat, then a hand-over holding nothing lets the next switch answer at once', async () => {
    const id = h.freshConvoId('handover-then-empty');
    const empty = h.freshConvoId('handover-empty');
    const other = second('Seventh');
    const third = second('Ninth');
    const text = 'ASK-HOTHEN just words';
    answers(['ASK-HOTHEN']);
    const held = transition(id);
    try {
      chat(id, text, undefined);
      assert.ok(await h.waitUntil(() => held.queued.length === 1), 'the chat is queued by the first hand-over');
      let asked = client.messages.length;
      client.send({ type: 'set_workspace', path: other });
      await h.delay(200);
      assert.ok(!client.messages.slice(asked).some(isAnswer), 'no workspace_set while the first hand-over holds the chat');
      endTransition(id);
      const first = await answerAfter(id, asked);
      assert.ok(first && first.set.type === 'workspace_set' && first.set.path === other, 'the switch goes ahead once the first hand-over ends');
      assert.strictEqual(first.held, false, 'and not before');
      assert.deepStrictEqual(userRowsIn(h.workspaceDir, id), [text], 'the replayed chat is in the first workspace\'s transcript');

      const t = transition(empty);
      asked = client.messages.length;
      client.send({ type: 'set_workspace', path: third });
      const next = await answerAfter(empty, asked, 2000);
      assert.ok(next && next.set.type === 'workspace_set' && next.set.path === third, 'the next switch answers within 2 s');
      assert.strictEqual(next.held, true, 'while the second hand-over is still open');
      assert.strictEqual(t.queued.length, 0, 'holding nothing');
    } finally {
      if (h.internal.convoTransitions.has(empty)) endTransition(empty);
      await leave(id);
      h.reapConvo(empty);
    }
  });

  test('a hand-over nothing else ends holds the switch until its failsafe flushes it, and no longer', async () => {
    const id = h.freshConvoId('handover-failsafe');
    const other = second('Eighth');
    const tag = 'ASK-HOSAFE';
    answers([tag]);
    const t = h.internal.wsHandlerContext.transitions.beginConvoTransition(id, 'killing', {});
    try {
      const since = client.messages.length;
      chat(id, `${tag} see this`, [file('Screen Shot.png', png())]);
      const stored = await storedFor(id, since);
      assert.ok(stored, 'the message is answered with chat_stored');
      assert.ok(await h.waitUntil(() => t.queued.length === 1), 'and queued by the hand-over');
      const asked = client.messages.length;
      const waiting = answerAfter(id, asked, 15000);
      client.send({ type: 'set_workspace', path: other });
      const answered = await waiting;
      assert.ok(answered && answered.set.type === 'workspace_set' && answered.set.path === other, 'the switch goes ahead within 15 s');
      assert.strictEqual(answered.held, false, 'once the failsafe has ended the hand-over, not before');
      await h.delay(500);
      assert.deepStrictEqual(refusedFor(id, since), [], 'no chat_refused');
      assert.deepStrictEqual(recordIn(h.workspaceDir, id), [stored.entry], 'the message is recorded in the first workspace');
      assert.deepStrictEqual(userRowsIn(h.workspaceDir, id), [stored.content], 'with its transcript row');
      assert.strictEqual(transcriptIn(other, id), null, 'and the second has no transcript for it');
    } finally {
      await leave(id);
    }
  });
});

describe('after every test above', () => {
  test('no receive ended in an unhandled rejection', () => {
    const answered = new Set(client.messages.map((m) => m.type));
    assert.ok(answered.has('chat_stored') && answered.has('chat_refused'), 'messages with files were stored and refused above');
    assert.deepStrictEqual(rejections, []);
  });
});
