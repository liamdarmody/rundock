'use strict';
// Integration: what a Claude Code process is sent for a person's turn, at
// each place the server hands one a turn.
//
// A turn's text has every stored line checked against the conversation's
// record as it is then: a file still as it was sent keeps its line, and one
// deleted since says it is not available, naming no path. A message stored
// with images or PDFs is sent as an array: its text, then a block for each
// image and PDF, read from the stored copy. Text alone is sent exactly as
// before, as a string. The stub logs each stdin line as it read it, and keeps
// the turn in its session file as it was sent.
//
// Every wait is h.waitUntil, which returns false on timeout, followed by an
// assertion.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const h = require('../helpers/harness.js');
const { standardTeam } = require('../helpers/workspace.js');

let client;
before(async () => {
  await h.boot({ agents: standardTeam() });
  client = await h.connect();
});
after(async () => h.shutdown());

// The first message after `since` that matches, once one arrives.
async function arrived(pred, { since = 0, timeout = 8000 } = {}) {
  await h.waitUntil(() => client.messages.slice(since).some(pred), { timeout });
  return client.messages.slice(since).find(pred);
}

const file = (name, bytes) => ({ name, data: bytes.toString('base64') });
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
const SCREENSHOT = png();
const REPORT = pdf();
const OTHER = png(320, 200, 41);

const folderOf = (id) => path.join(h.workspaceDir, '.rundock', 'attachments', id);
const imageBlock = (bytes) => ({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: bytes.toString('base64') } });
const pdfBlock = (bytes) => ({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: bytes.toString('base64') } });
// A turn's stdin line, as the server writes one with `content`.
const lineOf = (content) => JSON.stringify({ type: 'user', message: { role: 'user', content } });

function scenario(rules, deadSessions = [], extra = {}) {
  fs.writeFileSync(path.join(h.workspaceDir, 'stub-scenario.json'), JSON.stringify({ ...extra, rules, deadSessions }));
}
// Each tag answered `DONE-<tag>`, its session file kept as a chat run keeps it.
const answers = (tags, extra = {}) => scenario(tags.map((tag) => ({ match: { promptIncludes: tag }, turn: [{ text: `DONE-${tag}` }], keepSession: true })), [], extra);
// A listed conversation whose stored session `sessionId` the stub refuses.
function seed(id, sessionId) {
  const all = h.internal.readConversations().filter((c) => c.id !== id);
  h.internal.writeConversations([{ id, title: id, status: 'active', agentId: 'chief-of-staff', sessionId,
    sessionIds: [{ agentId: 'chief-of-staff', sessionId }] }, ...all]);
}
const spawnsFor = (id) => h.readInvocations().filter((i) => i.env && i.env.RUNDOCK_CONVO_ID === id);

function chat(id, content, attachments, extra = {}) {
  const msg = { type: 'chat', conversationId: id, agent: 'chief-of-staff', content, ...extra };
  if (attachments !== undefined) msg.attachments = attachments;
  client.send(msg);
}
const storedFor = (id, since) => arrived((m) => m.type === 'chat_stored' && m.conversationId === id, { since });
const resultFor = (id, text, since) => arrived((m) => m.type === 'result' && m._conversationId === id && String(m.result || '').includes(text), { since, timeout: 15000 });

// Each stdin line read for a turn whose text holds `tag`, with its content
// parsed and the session it was read by.
const sentWith = (tag) => h.readPrompts().filter((p) => p.prompt.includes(tag))
  .map((p) => ({ line: p.line, content: JSON.parse(p.line).message.content, sessionId: p.sessionId, resume: p.resume || null }));
// The one such line, once it has been read.
async function oneSent(tag) {
  assert.ok(await h.waitUntil(() => sentWith(tag).length > 0, { timeout: 15000 }), `a turn with ${tag} is read`);
  const sent = sentWith(tag);
  assert.strictEqual(sent.length, 1, `one turn with ${tag}`);
  return sent[0];
}
// The user messages of the stub's session file for `sessionId`.
function sessionUsers(sessionId) {
  const project = fs.realpathSync(h.workspaceDir).replace(/[^a-zA-Z0-9]/g, '-');
  const at = path.join(process.env.HOME, '.claude', 'projects', project, `${sessionId}.jsonl`);
  assert.ok(fs.existsSync(at), `the session file is at ${at}`);
  return h.readAppendedLog(at).filter((l) => l.type === 'user').map((l) => l.message.content);
}

// The stored message's turn: its text, then the PNG's block, then the PDF's,
// and the session file keeps the same array.
function sentWithBlocks(sent, stored) {
  assert.ok(Array.isArray(sent.content), 'the turn is an array');
  assert.deepStrictEqual(sent.content, [{ type: 'text', text: stored.content }, imageBlock(SCREENSHOT), pdfBlock(REPORT)],
    'the stored text, then a block for the PNG and one for the PDF, each from its stored bytes');
  assert.ok(sessionUsers(sent.sessionId).some((c) => JSON.stringify(c) === JSON.stringify(sent.content)),
    'the session file keeps the turn as the array it was sent');
}

// A line for `stored`'s first file, which has since been deleted.
function deletedLine(id, stored) {
  const [line] = stored.content.split('\n').filter((l) => l.startsWith('[Attached: '));
  fs.rmSync(path.join(folderOf(id), stored.entry.files[0].file));
  return line;
}
const gone = (stored) => `[Attached file not available: ${stored.entry.files[0].file}]`;

// What a text-only turn and a deleted file's line are sent as: the text alone
// byte for byte as before, and the line in its not-available form.
function textAndGone(plain, plainText, missing, missingText, stored) {
  assert.strictEqual(plain.line, lineOf(plainText), 'a text-only turn is the line it always was');
  assert.strictEqual(missing.line, lineOf(`${missingText}\n${gone(stored)}`), 'the deleted file is named as not available');
  assert.ok(!missing.line.includes('.rundock/attachments/'), 'and no path is given');
}

describe('a follow-up written into the conversation\'s live process', () => {
  test('a follow-up stored with a PNG and a PDF is sent its text and a block for each', async () => {
    const id = h.freshConvoId('turn-follow');
    answers(['OPEN-F1', 'FOLLOW-F1']);
    h.clearInvocations();
    const since = client.messages.length;
    chat(id, 'OPEN-F1 hello');
    assert.ok(await resultFor(id, 'DONE-OPEN-F1', since), 'the first message is answered');
    const mid = client.messages.length;
    chat(id, 'FOLLOW-F1 see these', [file('screenshot.png', SCREENSHOT), file('report.pdf', REPORT)]);
    const stored = await storedFor(id, mid);
    assert.ok(stored, 'the follow-up is stored');
    assert.ok(await resultFor(id, 'DONE-FOLLOW-F1', mid), 'and answered');
    assert.strictEqual(spawnsFor(id).length, 1, 'by the process the first message started');
    sentWithBlocks(await oneSent('FOLLOW-F1'), stored);
    h.reapConvo(id);
  });

  test('text alone is sent as it always was, and a line for a deleted file says it is not available', async () => {
    const id = h.freshConvoId('turn-follow-gone');
    answers(['OPEN-F2', 'PLAIN-F2', 'GONE-F2']);
    h.clearInvocations();
    const since = client.messages.length;
    chat(id, 'OPEN-F2 see this', [file('screenshot.png', SCREENSHOT)]);
    const stored = await storedFor(id, since);
    assert.ok(stored && await resultFor(id, 'DONE-OPEN-F2', since), 'the first message is stored and answered');
    const line = deletedLine(id, stored);
    chat(id, 'PLAIN-F2 just words');
    assert.ok(await resultFor(id, 'DONE-PLAIN-F2', since), 'the text is answered');
    chat(id, `GONE-F2 again\n${line}`);
    assert.ok(await resultFor(id, 'DONE-GONE-F2', since), 'the line is answered');
    assert.strictEqual(spawnsFor(id).length, 1, 'each by the live process');
    textAndGone(await oneSent('PLAIN-F2'), 'PLAIN-F2 just words', await oneSent('GONE-F2'), 'GONE-F2 again', stored);
    h.reapConvo(id);
  });
});

describe('the first message to a process started for it', () => {
  for (const legacy of [false, true]) {
    const kind = legacy ? 'legacy' : 'interactive';
    const T = legacy ? 'L' : 'N';

    test(`a ${kind} start for a message stored with a PNG and a PDF is sent its text and a block for each`, async () => {
      const id = h.freshConvoId(`turn-new-${kind}`);
      answers([`NEW-${T}1`]);
      h.clearInvocations();
      if (legacy) process.env.RUNDOCK_LEGACY_SPAWN = '1';
      const since = client.messages.length;
      let stored;
      try {
        chat(id, `NEW-${T}1 see these`, [file('screenshot.png', SCREENSHOT), file('report.pdf', REPORT)]);
        stored = await storedFor(id, since);
        assert.ok(stored, 'the message is stored');
        assert.ok(await resultFor(id, `DONE-NEW-${T}1`, since), 'and answered');
      } finally {
        delete process.env.RUNDOCK_LEGACY_SPAWN;
      }
      assert.strictEqual(spawnsFor(id).length, 1, 'by a process started for it');
      sentWithBlocks(await oneSent(`NEW-${T}1`), stored);
      h.reapConvo(id);
    });

    test(`a ${kind} start for text alone is sent it as it always was, and a line for a deleted file says it is not available`, async () => {
      const id = h.freshConvoId(`turn-new-${kind}-gone`);
      answers([`OPEN-${T}2`, `PLAIN-${T}2`, `GONE-${T}2`]);
      h.clearInvocations();
      if (legacy) process.env.RUNDOCK_LEGACY_SPAWN = '1';
      const since = client.messages.length;
      let stored;
      try {
        chat(id, `OPEN-${T}2 see this`, [file('screenshot.png', SCREENSHOT)]);
        stored = await storedFor(id, since);
        assert.ok(stored && await resultFor(id, `DONE-OPEN-${T}2`, since), 'the first message is stored and answered');
        const line = deletedLine(id, stored);
        h.reapConvo(id);
        chat(id, `PLAIN-${T}2 just words`);
        assert.ok(await resultFor(id, `DONE-PLAIN-${T}2`, since), 'the text is answered');
        h.reapConvo(id);
        chat(id, `GONE-${T}2 again\n${line}`);
        assert.ok(await resultFor(id, `DONE-GONE-${T}2`, since), 'the line is answered');
      } finally {
        delete process.env.RUNDOCK_LEGACY_SPAWN;
      }
      assert.strictEqual(spawnsFor(id).length, 3, 'each by a process started for it');
      textAndGone(await oneSent(`PLAIN-${T}2`), `PLAIN-${T}2 just words`, await oneSent(`GONE-${T}2`), `GONE-${T}2 again`, stored);
      h.reapConvo(id);
    });
  }
});

describe('a refused resume started fresh, with what was sent while it was starting', () => {
  const expired = (id, since) => arrived((m) => m.subtype === 'session_expired' && m._conversationId === id, { since, timeout: 15000 });

  test('the fresh start is sent the stored message as an array with its blocks, built from the record', async () => {
    const id = h.freshConvoId('turn-retry');
    seed(id, 'dead-turn-r');
    scenario([{ match: { promptIncludes: 'ASK-R1' }, turn: [{ text: 'FRESH-R1' }], keepSession: true }], ['dead-turn-r'], { refusalAfterInit: true });
    h.clearInvocations();
    const since = client.messages.length;
    chat(id, 'ASK-R1 see these', [file('screenshot.png', SCREENSHOT), file('report.pdf', REPORT)], { sessionId: 'dead-turn-r' });
    const stored = await storedFor(id, since);
    assert.ok(stored, 'the message is stored');
    assert.ok(await resultFor(id, 'FRESH-R1', since), 'the fresh start answers');
    assert.deepStrictEqual(spawnsFor(id).map((i) => i.resume), ['dead-turn-r', null], 'refused once, then started fresh');
    const sent = await oneSent('ASK-R1');
    assert.strictEqual(sent.resume, null, 'read by the fresh start');
    sentWithBlocks(sent, stored);
    h.reapConvo(id);
  });

  test('a text-only message sent while it was starting is re-emitted with no record entry, and arrives as a string', async () => {
    const id = h.freshConvoId('turn-retry-text');
    seed(id, 'dead-turn-t');
    scenario([
      { match: { promptIncludes: 'FIRST-T' }, turn: [{ text: 'DONE-FIRST-T' }] },
      { match: { promptIncludes: 'SECOND-T' }, turn: [{ text: 'DONE-SECOND-T' }] },
    ], ['dead-turn-t'], { refusalExitMs: 1200 });
    h.clearInvocations();
    const rec = recordReentries();
    const since = client.messages.length;
    let first;
    try {
      chat(id, 'FIRST-T see this', [file('screenshot.png', SCREENSHOT)], { sessionId: 'dead-turn-t' });
      first = await storedFor(id, since);
      assert.ok(first, 'the first is stored');
      assert.ok(await expired(id, since), 'the resume is refused and still lingering');
      chat(id, 'SECOND-T just words');
      assert.ok(await resultFor(id, 'DONE-SECOND-T', since), 'the second is answered');
    } finally {
      rec.stop();
    }
    const again = rec.seen.filter((m) => m.conversationId === id && m.content === 'SECOND-T just words');
    assert.strictEqual(again.length, 1, 'the second is sent back into the handler once');
    assert.ok(!('attachmentEntry' in again[0]), 'with no record entry, not the first message\'s');
    assert.deepStrictEqual((await oneSent('FIRST-T')).content, [{ type: 'text', text: first.content }, imageBlock(SCREENSHOT)],
      'the first arrives with its block');
    assert.strictEqual((await oneSent('SECOND-T')).line, lineOf('SECOND-T just words'), 'the second as a string, as it always was');
    h.reapConvo(id);
  });

  test('a message with its own PNG sent while it was starting arrives with its own block, not the first message\'s', async () => {
    const id = h.freshConvoId('turn-retry-own');
    seed(id, 'dead-turn-o');
    scenario([
      { match: { promptIncludes: 'FIRST-O' }, turn: [{ text: 'DONE-FIRST-O' }] },
      { match: { promptIncludes: 'SECOND-O' }, turn: [{ text: 'DONE-SECOND-O' }] },
    ], ['dead-turn-o'], { refusalExitMs: 1200 });
    h.clearInvocations();
    const since = client.messages.length;
    chat(id, 'FIRST-O see this', [file('screenshot.png', SCREENSHOT)], { sessionId: 'dead-turn-o' });
    const first = await storedFor(id, since);
    assert.ok(first, 'the first is stored');
    assert.ok(await expired(id, since), 'the resume is refused and still lingering');
    const mid = client.messages.length;
    chat(id, 'SECOND-O and this one', [file('diagram.png', OTHER)]);
    const second = await storedFor(id, mid);
    assert.ok(second, 'the second is stored');
    assert.ok(await resultFor(id, 'DONE-SECOND-O', since), 'and answered');
    assert.deepStrictEqual(spawnsFor(id).map((i) => i.resume), ['dead-turn-o', null], 'one fresh start carries both');
    assert.deepStrictEqual((await oneSent('FIRST-O')).content, [{ type: 'text', text: first.content }, imageBlock(SCREENSHOT)],
      'the first with its own block');
    assert.deepStrictEqual((await oneSent('SECOND-O')).content, [{ type: 'text', text: second.content }, imageBlock(OTHER)],
      'the second with its own block alone');
    h.reapConvo(id);
  });
});

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
