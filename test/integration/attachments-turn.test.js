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
const { standardTeam, agentFile } = require('../helpers/workspace.js');
const { MARKERS } = require('../fixtures/stream-json.js');
const { receiveAttachments } = require('../../lib/attachments/receive.js');

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

// A file of the conversation's, stored and then deleted: its line as the
// record names it, and the form a turn carries in its place.
async function goneLine(id) {
  const { content, entry } = await receiveAttachments(h.workspaceDir, { conversationId: id, content: '', attachments: [file('screenshot.png', SCREENSHOT)] });
  fs.rmSync(path.join(folderOf(id), entry.files[0].file));
  return { line: content, form: `[Attached file not available: ${entry.files[0].file}]` };
}
const swap = (text, gone) => text.split(gone.line).join(gone.form);

// The one stdin line `agent` read whose text holds every tag, read by a
// process started with no session when `fresh`.
async function readBy(agent, tags, { fresh = false } = {}) {
  const all = [].concat(tags);
  const pick = () => h.readPrompts().filter((p) => p.agent === agent && all.every((t) => p.prompt.includes(t))
    && p.line !== undefined && (!fresh || p.resume == null));
  assert.ok(await h.waitUntil(() => pick().length > 0, { timeout: 15000 }), `${agent} reads a turn with ${all.join(', ')}`);
  const found = pick();
  assert.strictEqual(found.length, 1, `one turn with ${all.join(', ')}`);
  return { line: found[0].line, content: JSON.parse(found[0].line).message.content, resume: found[0].resume || null };
}
// Text alone, sent as a string in exactly the line it always was.
function plain(sent, expected) {
  assert.strictEqual(typeof sent.content, 'string', 'text alone is sent as a string');
  assert.strictEqual(sent.line, lineOf(expected === undefined ? sent.content : expected), 'in the line it always was');
}
// A deleted file's line, sent as not available, with no path anywhere.
function noLonger(sent, gone) {
  assert.strictEqual(typeof sent.content, 'string', 'a turn with no files is sent as a string');
  assert.ok(sent.content.includes(gone.form), 'the deleted file is named as not available');
  assert.ok(!sent.line.includes('.rundock/attachments/'), 'and no path is given');
}
function seedRecord(id, record) {
  const all = h.internal.readConversations().filter((c) => c.id !== id);
  h.internal.writeConversations([{ id, title: id, status: 'active', ...record }, ...all]);
}
const leadSpawns = (id) => spawnsFor(id).filter((i) => i.agent === 'content-lead').map((i) => i.resume);
const lineIn = (stored) => stored.content.split('\n').find((l) => l.startsWith('[Attached: '));

describe('each turn the server writes for an agent of its own accord', () => {
  const expired = (id, since) => arrived((m) => m.subtype === 'session_expired' && m._conversationId === id, { since, timeout: 15000 });
  const blocked = (offName, name) => `[SYSTEM: delegation-blocked] Your Agent tool call named "${offName}" (${name}), a workspace agent who is not one of your direct reports, so it was NOT run. No subagent may act as ${offName}. Do not retry the same call. If the task needs ${offName}, tell the user this needs routing through ${offName}'s leader and hand back. Otherwise continue without them.`;
  const routeOn = (who, pending) => `[SYSTEM: ${who} just returned because the user asked for something outside their scope. The user's pending request is: "${pending}"\n\nRoute this request now. Delegate to the right specialist if one fits, or handle it yourself. Do not summarise what the previous specialist did. Do not ask the user to repeat themselves. Respond to their request.]`;

  test('a blocked handoff\'s notice is sent as text alone, and a deleted file\'s line in it as not available', async () => {
    const agentAt = path.join(h.workspaceDir, '.claude', 'agents', 'gone-designer.md');
    for (const half of ['T', 'G']) {
      const id = h.freshConvoId(`turn-block-${half}`);
      let target = 'lead-designer';
      let offName = 'Des';
      let gone = null;
      if (half === 'G') {
        // An agent off the lead's team whose name is the deleted file's line.
        gone = await goneLine(id);
        fs.writeFileSync(agentAt, agentFile({ name: 'gone-designer', displayName: gone.line, role: 'Designer',
          description: 'Visual design', type: 'specialist', order: 9, reportsTo: 'chief-of-staff', body: 'You make visuals.' }));
        h.internal.invalidateAgentCache();
        target = 'gone-designer';
        offName = gone.line;
      }
      try {
        scenario([
          { match: { agent: 'content-lead', promptIncludes: `TASK-4${half}`, promptExcludes: '[SYSTEM:' },
            turn: [{ text: 'Handing over.' }, { agentTool: { subagent_type: target, prompt: 'x' } }] },
          { match: { agent: 'content-lead', promptIncludes: '[SYSTEM: delegation-blocked]' }, turn: [{ text: 'OK' }] },
        ]);
        h.clearInvocations();
        chat(id, `TASK-4${half} please`, undefined, { agent: 'content-lead' });
        const sent = await readBy('content-lead', '[SYSTEM: delegation-blocked]');
        if (gone) {
          noLonger(sent, gone);
          assert.strictEqual(sent.content, swap(blocked(offName, target), gone), 'the notice with each line replaced');
        } else {
          plain(sent, blocked(offName, target));
        }
      } finally {
        if (gone) {
          fs.rmSync(agentAt, { force: true });
          h.internal.invalidateAgentCache();
        }
      }
      h.reapConvo(id);
    }
  });

  test('a delegate\'s brief is sent as text alone, and a deleted file\'s line in it as not available', async () => {
    for (const half of ['T', 'G']) {
      const id = h.freshConvoId(`turn-brief-${half}`);
      const gone = half === 'G' ? await goneLine(id) : null;
      const brief = gone ? `BRIEF-8G ${gone.line}` : 'BRIEF-8T write it';
      scenario([
        { match: { agent: 'chief-of-staff', promptIncludes: `ASK-8${half}`, promptExcludes: '[SYSTEM:' },
          turn: [{ agentTool: { subagent_type: 'content-lead', prompt: brief } }] },
        { match: { agent: 'content-lead', promptIncludes: `BRIEF-8${half}` }, turn: [{ text: 'Done.' }] },
        { match: { promptIncludes: '[SYSTEM:' }, turn: [{ text: '<silent>' }] },
      ]);
      h.clearInvocations();
      chat(id, `ASK-8${half} please`);
      const sent = await readBy('content-lead', `BRIEF-8${half}`);
      if (gone) {
        noLonger(sent, gone);
        assert.ok(sent.content.includes(`[DELEGATION BRIEF]\n${swap(brief, gone)}`), 'the brief with its line replaced');
      } else {
        plain(sent);
        assert.ok(sent.content.includes(`[DELEGATION BRIEF]\n${brief}`), 'the brief as it was written');
      }
      h.reapConvo(id);
    }
  });

  test('a delegate is sent the images of the message its leader was answering, though the brief leaves their lines out', async () => {
    const id = h.freshConvoId('turn-brief-png');
    scenario([
      { match: { agent: 'chief-of-staff', promptIncludes: 'ASK-5A', promptExcludes: '[SYSTEM:' },
        turn: [{ agentTool: { subagent_type: 'content-lead', prompt: 'BRIEF-5A do it' } }] },
      { match: { agent: 'content-lead', promptIncludes: 'BRIEF-5A' }, turn: [{ text: 'Done.' }] },
      { match: { promptIncludes: '[SYSTEM:' }, turn: [{ text: '<silent>' }] },
    ]);
    h.clearInvocations();
    const since = client.messages.length;
    chat(id, 'ASK-5A see this', [file('screenshot.png', SCREENSHOT)]);
    const stored = await storedFor(id, since);
    assert.ok(stored, 'the message is stored');
    const sent = await readBy('content-lead', 'BRIEF-5A do it');
    assert.ok(Array.isArray(sent.content), 'the brief is an array');
    assert.strictEqual(sent.content[0].type, 'text');
    assert.ok(sent.content[0].text.includes('BRIEF-5A do it'), 'its text holds the brief');
    assert.ok(sent.content[0].text.includes(lineIn(stored)), 'and the PNG\'s line');
    assert.deepStrictEqual(sent.content.slice(1), [imageBlock(SCREENSHOT)], 'then the PNG\'s block');
    h.reapConvo(id);
  });

  test('a delegation from a follow-up with no files sends the delegate no blocks', async () => {
    const id = h.freshConvoId('turn-brief-after');
    scenario([
      { match: { agent: 'chief-of-staff', promptIncludes: 'NEXT-5B', promptExcludes: '[SYSTEM:' },
        turn: [{ agentTool: { subagent_type: 'content-lead', prompt: 'BRIEF-5B do it' } }] },
      { match: { agent: 'chief-of-staff', promptIncludes: 'ASK-5B', promptExcludes: '[SYSTEM:' }, turn: [{ text: 'DONE-ASK-5B' }] },
      { match: { agent: 'content-lead', promptIncludes: 'BRIEF-5B' }, turn: [{ text: 'Done.' }] },
      { match: { promptIncludes: '[SYSTEM:' }, turn: [{ text: '<silent>' }] },
    ]);
    h.clearInvocations();
    const since = client.messages.length;
    chat(id, 'ASK-5B see this', [file('screenshot.png', SCREENSHOT)]);
    assert.ok(await storedFor(id, since) && await resultFor(id, 'DONE-ASK-5B', since), 'the first message is stored and answered');
    assert.deepStrictEqual((await readBy('chief-of-staff', 'ASK-5B')).content.slice(1), [imageBlock(SCREENSHOT)], 'the leader was sent the PNG');
    chat(id, 'NEXT-5B no files');
    const sent = await readBy('content-lead', 'BRIEF-5B');
    plain(sent);
    h.reapConvo(id);
  });

  // A conversation whose specialist's stored session is gone: a delegation to
  // it is refused its resume and starts fresh in the same place.
  function staleLead(id, t, ask, brief, extra) {
    seedRecord(id, { agentId: 'chief-of-staff', sessionId: `live-orch-${t}`,
      sessionIds: [{ agentId: 'chief-of-staff', sessionId: `live-orch-${t}` }, { agentId: 'content-lead', sessionId: `dead-lead-${t}` }] });
    scenario([
      { match: { resume: true, promptIncludes: ask, promptExcludes: 'DELEGATION BRIEF' },
        turn: [{ agentTool: { subagent_type: 'content-lead', prompt: brief } }] },
      { match: { agent: 'content-lead', promptIncludes: 'BRIEF-' }, turn: [{ text: 'Done.' }] },
      { match: { agent: 'content-lead', promptIncludes: 'FOLLOW-' }, turn: [{ text: 'Followed.' }] },
      { match: { promptIncludes: '[SYSTEM:' }, turn: [{ text: '<silent>' }] },
    ], [`dead-lead-${t}`], extra);
  }

  test('a delegate started fresh after its session was refused is sent its brief with the PNG\'s block', async () => {
    const id = h.freshConvoId('turn-fresh-png');
    staleLead(id, '5c', 'ASK-5C', 'BRIEF-5C do it');
    h.clearInvocations();
    const since = client.messages.length;
    chat(id, 'ASK-5C see this', [file('screenshot.png', SCREENSHOT)], { sessionId: 'live-orch-5c' });
    const stored = await storedFor(id, since);
    assert.ok(stored, 'the message is stored');
    const sent = await readBy('content-lead', 'BRIEF-5C do it', { fresh: true });
    assert.deepStrictEqual(leadSpawns(id), ['dead-lead-5c', null], 'refused once, then started fresh');
    assert.ok(Array.isArray(sent.content), 'the brief is an array');
    assert.ok(sent.content[0].text.includes('BRIEF-5C do it') && sent.content[0].text.includes(lineIn(stored)), 'its text holds the brief and the PNG\'s line');
    assert.deepStrictEqual(sent.content.slice(1), [imageBlock(SCREENSHOT)], 'then the PNG\'s block');
    h.reapConvo(id);
  });

  test('a delegate started fresh is sent a text brief as it always was, and a deleted file\'s line as not available', async () => {
    for (const half of ['T', 'G']) {
      const id = h.freshConvoId(`turn-fresh-${half}`);
      const t = `5${half.toLowerCase()}`;
      const gone = half === 'G' ? await goneLine(id) : null;
      const brief = gone ? `BRIEF-5${half} ${gone.line}` : `BRIEF-5${half} write it`;
      staleLead(id, t, `ASK-5${half}`, brief);
      h.clearInvocations();
      chat(id, `ASK-5${half} please`, undefined, { sessionId: `live-orch-${t}` });
      const sent = await readBy('content-lead', `BRIEF-5${half}`, { fresh: true });
      assert.deepStrictEqual(leadSpawns(id), [`dead-lead-${t}`, null], 'refused once, then started fresh');
      if (gone) {
        noLonger(sent, gone);
        assert.ok(sent.content.includes(`[DELEGATION BRIEF]\n${swap(brief, gone)}`), 'the brief with its line replaced');
      } else {
        plain(sent);
        assert.ok(sent.content.includes(`[DELEGATION BRIEF]\n${brief}`), 'the brief as it was written');
      }
      h.reapConvo(id);
    }
  });

  // What a follow-up sent to the delegate while its refused resume lingers is
  // read as by the fresh start, with the brief that start was sent. With
  // `withGone`, the follow-up names a file of the conversation's that is
  // deleted before it is sent.
  async function keptFollowUp(half, ask, askFiles, follow, followFiles, { withGone = false } = {}) {
    const id = h.freshConvoId(`turn-kept-${half}`);
    const t = `6${half.toLowerCase()}`;
    const gone = withGone ? await goneLine(id) : null;
    if (gone) follow = `${follow} ${gone.line}`;
    staleLead(id, t, `ASK-6${half}`, `BRIEF-6${half} do it`, { refusalExitMs: 1200 });
    h.clearInvocations();
    const since = client.messages.length;
    chat(id, ask, askFiles, { sessionId: `live-orch-${t}` });
    // Only a message that sent files is answered with chat_stored.
    const first = askFiles ? await storedFor(id, since) : null;
    if (askFiles) assert.ok(first, 'the message is stored');
    assert.ok(await expired(id, since), 'the delegate\'s resume is refused and still lingering');
    const mid = client.messages.length;
    chat(id, follow, followFiles, { agent: 'content-lead' });
    const stored = followFiles ? await storedFor(id, mid) : null;
    if (followFiles) assert.ok(stored, 'the follow-up is stored');
    const sent = await readBy('content-lead', `FOLLOW-6${half}`, { fresh: true });
    const brief = await readBy('content-lead', `BRIEF-6${half}`, { fresh: true });
    assert.deepStrictEqual(leadSpawns(id), [`dead-lead-${t}`, null], 'one fresh start carries both');
    h.reapConvo(id);
    return { first, stored, sent, brief, gone };
  }

  test('a follow-up kept for a delegate starting fresh is sent as text alone, and a deleted file\'s line in it as not available', async () => {
    const plainRun = await keptFollowUp('T', 'ASK-6T please', undefined, 'FOLLOW-6T just words');
    plain(plainRun.sent, 'FOLLOW-6T just words');
    const goneRun = await keptFollowUp('G', 'ASK-6G please', undefined, 'FOLLOW-6G', undefined, { withGone: true });
    noLonger(goneRun.sent, goneRun.gone);
    assert.strictEqual(goneRun.sent.content, `FOLLOW-6G ${goneRun.gone.form}`, 'the follow-up with its line replaced');
  });

  test('a follow-up with its own PNG kept for a delegate starting fresh is sent its own block, and the brief only the first message\'s', async () => {
    const run = await keptFollowUp('D', 'ASK-6D see this', [file('screenshot.png', SCREENSHOT)], 'FOLLOW-6D and this one', [file('diagram.png', OTHER)]);
    assert.deepStrictEqual(run.sent.content, [{ type: 'text', text: run.stored.content }, imageBlock(OTHER)], 'the follow-up with its own block alone');
    assert.ok(Array.isArray(run.brief.content), 'the brief is an array');
    assert.deepStrictEqual(run.brief.content.slice(1), [imageBlock(SCREENSHOT)], 'with the first message\'s block alone');
  });

  test('a leader started fresh for a handback is sent it as text alone, and a deleted file\'s line in it as not available', async () => {
    for (const half of ['T', 'G']) {
      const id = h.freshConvoId(`turn-orch-fresh-${half}`);
      const t = `5o${half.toLowerCase()}`;
      const gone = half === 'G' ? await goneLine(id) : null;
      const req = gone ? `REQ-5O${half} ${gone.line}` : `REQ-5O${half} just words`;
      seedRecord(id, { agentId: 'chief-of-staff', activeAgentId: 'content-lead', sessionId: `dead-orch-${t}`,
        sessionIds: [{ agentId: 'chief-of-staff', sessionId: `dead-orch-${t}` }, { agentId: 'content-lead', sessionId: `live-lead-${t}` }] });
      scenario([
        { match: { resume: true, promptIncludes: `REQ-5O${half}` }, turn: [{ text: `Not mine. ${MARKERS.RETURN}` }] },
        { match: { agent: 'chief-of-staff', promptIncludes: 'routing-request' }, turn: [{ text: 'Routing.' }] },
      ], [`dead-orch-${t}`]);
      h.clearInvocations();
      chat(id, req, undefined, { agent: 'content-lead', sessionId: `live-lead-${t}` });
      const sent = await readBy('chief-of-staff', 'routing-request', { fresh: true });
      if (gone) {
        noLonger(sent, gone);
        assert.ok(sent.content.includes(`The user's latest request was: "${swap(req, gone)}"`), 'the request with its line replaced');
      } else {
        plain(sent);
        assert.ok(sent.content.includes('[SYSTEM: routing-request] content-lead returned because the request was outside their scope.'), 'the routing request');
        assert.ok(sent.content.includes(`The user's latest request was: "${req}"`), 'with the request as it was written');
      }
      h.reapConvo(id);
    }
  });

  test('a handback to the leader is sent as text alone, and a deleted file\'s line in it as not available', async () => {
    for (const half of ['T', 'G']) {
      const id = h.freshConvoId(`turn-handback-${half}`);
      const gone = half === 'G' ? await goneLine(id) : null;
      const task = gone ? `TASK-7${half} ${gone.line}` : `TASK-7${half} just words`;
      scenario([
        { match: { agent: 'content-lead', promptIncludes: `TASK-7${half}` }, turn: [{ text: `Not mine. ${MARKERS.RETURN}` }] },
        { match: { agent: 'chief-of-staff', promptIncludes: 'routing-request' }, turn: [{ text: 'Routing.' }] },
      ]);
      h.clearInvocations();
      chat(id, task, undefined, { agent: 'content-lead' });
      const sent = await readBy('chief-of-staff', 'routing-request');
      if (gone) {
        noLonger(sent, gone);
        assert.ok(sent.content.includes(`The user's latest request was: "${swap(task, gone)}"`), 'the request with its line replaced');
      } else {
        plain(sent);
        assert.ok(sent.content.includes('[SYSTEM: routing-request] content-lead returned because the request was outside their scope.'), 'the routing request');
        assert.ok(sent.content.includes(`The user's latest request was: "${task}"`), 'with the request as it was written');
      }
      h.reapConvo(id);
    }
  });

  test('a return from a sub-delegate to the leader is sent as text alone, and a deleted file\'s line in it as not available', async () => {
    for (const half of ['T', 'G']) {
      const id = h.freshConvoId(`turn-skip-${half}`);
      const gone = half === 'G' ? await goneLine(id) : null;
      const sub = gone ? `SUB-9${half} ${gone.line}` : `SUB-9${half} brief`;
      scenario([
        { match: { agent: 'chief-of-staff', promptIncludes: `SETUP-9${half}`, promptExcludes: '[SYSTEM:' }, turn: [{ text: 'Ready.' }] },
        { match: { agent: 'content-lead', promptIncludes: `TASK-9${half}` }, turn: [{ agentTool: { subagent_type: 'content-analyst', prompt: sub } }] },
        { match: { agent: 'content-analyst', promptIncludes: `SUB-9${half}` }, turn: [{ text: `Outside my scope. ${MARKERS.RETURN}` }] },
        { match: { agent: 'chief-of-staff', promptIncludes: 'A specialist just returned' }, turn: [{ text: 'Routing.' }] },
      ]);
      h.clearInvocations();
      chat(id, `SETUP-9${half}`);
      await client.waitForEvent('system', 'done', id);
      client.send({ type: 'delegate', conversationId: id, targetAgent: 'content-lead', context: `TASK-9${half} please` });
      const sent = await readBy('chief-of-staff', 'A specialist just returned');
      const expected = routeOn('A specialist', sub);
      if (gone) {
        noLonger(sent, gone);
        assert.strictEqual(sent.content, swap(expected, gone), 'the routing prompt with its line replaced');
      } else {
        plain(sent, expected);
      }
      h.reapConvo(id);
    }
  });

  // The three prompts a leader started again by its session is sent when a
  // delegate it handed to closes: out of scope, complete, and no marker.
  const closes = [
    { site: 10, marker: ` ${MARKERS.RETURN}`, reads: 'returned because the request was outside their scope',
      fixed: (out) => [`[SYSTEM: content-lead returned because the request was outside their scope. Here is what they said:\n\n--- content-lead ---\n${out}`],
      reply: 'Routing.' },
    { site: 11, marker: ` ${MARKERS.COMPLETE}`, reads: 'has finished the delegated work',
      fixed: (out) => [`[SYSTEM: pipeline-complete] content-lead has finished the delegated work. Here is their final message to the conversation:\n\n--- content-lead ---\n${out}`],
      reply: '<silent>' },
    { site: 12, marker: '', exitAfterTurn: 0, reads: 'completed their work',
      fixed: (out) => [`[SYSTEM: pipeline-complete] content-lead completed their work. Here is their final message to the conversation:\n\n--- content-lead ---\n${out}`],
      reply: '<silent>' },
  ];
  for (const close of closes) {
    test(`a leader started again for a delegate's close (${close.reads}) is sent it as text alone, and a deleted file's line in it as not available`, async () => {
      for (const half of ['T', 'G']) {
        const tag = `${close.site}${half}`;
        const id = h.freshConvoId(`turn-close-${tag}`);
        const gone = half === 'G' ? await goneLine(id) : null;
        const out = gone ? `OUT-${tag} ${gone.line}` : `OUT-${tag} here it is`;
        const leadRule = { match: { agent: 'content-lead', promptIncludes: `BRIEF-${tag}` }, turn: [{ text: `${out}${close.marker}` }] };
        if (close.exitAfterTurn !== undefined) leadRule.exitAfterTurn = close.exitAfterTurn;
        scenario([
          { match: { agent: 'chief-of-staff', promptIncludes: `ASK-${tag}`, promptExcludes: '[SYSTEM:' },
            turn: [{ agentTool: { subagent_type: 'content-lead', prompt: `BRIEF-${tag} go` } }] },
          leadRule,
          { match: { agent: 'chief-of-staff', promptIncludes: '[SYSTEM:' }, turn: [{ text: close.reply }] },
        ]);
        h.clearInvocations();
        chat(id, `ASK-${tag} please`);
        const sent = await readBy('chief-of-staff', [close.reads, `OUT-${tag}`]);
        assert.ok(sent.resume, 'read by the leader started again by its session');
        if (gone) {
          noLonger(sent, gone);
          for (const part of close.fixed(swap(out, gone))) assert.ok(sent.content.includes(part), 'the output with its line replaced');
        } else {
          plain(sent);
          for (const part of close.fixed(out)) assert.ok(sent.content.includes(part), `the prompt holds ${part}`);
          if (close.site === 10) assert.ok(sent.content.includes(`The user's latest request was: "BRIEF-${tag} go"`), 'and the brief as the request');
        }
        h.reapConvo(id);
      }
    });
  }

  test('a follow-up passed on to the leader when a delegation ends is sent as text alone, and a deleted file\'s line in it as not available', async () => {
    for (const half of ['T', 'G']) {
      const id = h.freshConvoId(`turn-ended-${half}`);
      const gone = half === 'G' ? await goneLine(id) : null;
      const follow = gone ? `FOLLOW-13${half} ${gone.line}` : `FOLLOW-13${half} please`;
      scenario([
        { match: { agent: 'chief-of-staff', promptIncludes: `SETUP-13${half}`, promptExcludes: '[SYSTEM:' }, turn: [{ text: 'Ready.' }] },
        { match: { agent: 'content-lead', promptIncludes: `FOLLOW-13${half}` }, turn: [{ text: 'Handled.' }] },
        { match: { agent: 'content-lead', promptIncludes: `TASK-13${half}` }, turn: [{ text: 'Here.' }] },
        { match: { agent: 'chief-of-staff', promptIncludes: 'The specialist just returned because the user asked' }, turn: [{ text: 'Routing.' }] },
      ]);
      h.clearInvocations();
      chat(id, `SETUP-13${half}`);
      await client.waitForEvent('system', 'done', id);
      const since = client.messages.length;
      client.send({ type: 'delegate', conversationId: id, targetAgent: 'content-lead', context: `TASK-13${half} please` });
      assert.ok(await arrived((m) => m.type === 'result' && m._conversationId === id && m._agent === 'content-lead', { since, timeout: 15000 }), 'the delegate answers');
      const mid = client.messages.length;
      chat(id, follow, undefined, { agent: 'content-lead' });
      assert.ok(await arrived((m) => m.type === 'result' && m._conversationId === id && m._agent === 'content-lead', { since: mid, timeout: 15000 }), 'and the follow-up');
      client.send({ type: 'end_delegation', conversationId: id });
      const sent = await readBy('chief-of-staff', 'The specialist just returned because the user asked');
      const expected = routeOn('The specialist', follow);
      if (gone) {
        noLonger(sent, gone);
        assert.strictEqual(sent.content, swap(expected, gone), 'the routing prompt with its line replaced');
      } else {
        plain(sent, expected);
      }
      h.reapConvo(id);
    }
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
