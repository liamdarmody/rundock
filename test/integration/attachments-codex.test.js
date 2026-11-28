'use strict';
// Integration: what a Codex agent is sent for a turn that names attached
// files, at the two places the server starts one, and what each send records.
// The last describe is Claude Code's side of the record: what a process was
// sent before it reported its session, recorded under the ID it reports.
//
// A Codex turn is a text item, then an item for each file the agent can take:
// a `localImage` naming an image's stored copy, or a text file's own text.
// After each test, every turn/start the stub Codex logged is checked both
// ways: each image line in the first text item has its file's `localImage`
// item, and each `localImage` item has its line.
//
// A message for a Codex conversation is stored here with receiveAttachments
// and sent with its `attachmentEntry`, as the server sends one on once it is
// stored.
//
// Every wait is h.waitUntil, which returns false on timeout, followed by an
// assertion.
const { test, describe, before, after, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const h = require('../helpers/harness.js');
const { standardTeam, agentFile } = require('../helpers/workspace.js');
const { receiveAttachments } = require('../../lib/attachments/receive.js');
const store = require('../../lib/attachments/store.js');
const glue = require('../../lib/runtime/codex-glue.js');

let client;
before(async () => {
  await h.boot({ agents: {
    ...standardTeam(),
    researcher: agentFile({ name: 'researcher', displayName: 'Ida', role: 'Researcher', description: 'Researches suppliers',
      type: 'specialist', order: 5, reportsTo: 'chief-of-staff', runtime: 'codex', body: 'You are Ida, the researcher.' }),
  } });
  client = await h.connect();
});
after(async () => h.shutdown());

// The stored copy of `file` in conversation `id`, as an absolute path.
const pathOf = (id, file) => path.join(path.resolve(h.workspaceDir), '.rundock', 'attachments', id, file);
const IMAGE_LINE = /\[Attached: \.rundock\/attachments\/([^/\s]+)\/([1-9][0-9]*-[A-Za-z0-9_-]+\.(?:png|jpg|gif|webp)) \([^)\]]*\)\]/g;

// Each image line in a turn's text has its item, and each item its line.
function checkPairing() {
  for (const call of h.readInvocations().filter((i) => i.mode === 'app-server' && i.method === 'turn/start')) {
    const input = (call.params && call.params.input) || [];
    const text = input[0] && input[0].type === 'text' ? input[0].text : '';
    const named = new Set([...text.matchAll(IMAGE_LINE)].map((m) => pathOf(m[1], m[2])));
    const items = input.filter((p) => p && p.type === 'localImage').map((p) => p.path);
    for (const want of named) assert.ok(items.includes(want), `the line for ${want} has its item`);
    for (const got of items) assert.ok(named.has(got), `the item for ${got} has its line`);
  }
}
afterEach(checkPairing);

async function arrived(pred, { since = 0, timeout = 15000 } = {}) {
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
const DIAGRAM = png();
const NOTES = Buffer.from('# Notes\nTwo suppliers.\n');
const REPORT = pdf();

function scenario(rules, deadSessions = [], extra = {}) {
  fs.writeFileSync(path.join(h.workspaceDir, 'stub-scenario.json'), JSON.stringify({ ...extra, rules, deadSessions }));
}
// Each tag answered `DONE-<tag>` by the Codex agent.
const codexAnswers = (tags, extra) => h.writeCodexScenario(tags.map((tag) => ({ match: { promptIncludes: tag }, text: `DONE-${tag}` })), extra);
function seedRecord(id, record) {
  const all = h.internal.readConversations().filter((c) => c.id !== id);
  h.internal.writeConversations([{ id, title: id, status: 'active', ...record }, ...all]);
}

function chat(id, content, attachments, extra = {}) {
  const msg = { type: 'chat', conversationId: id, agent: 'chief-of-staff', content, ...extra };
  if (attachments !== undefined) msg.attachments = attachments;
  client.send(msg);
}
// A message for the Codex conversation `id`, stored first, then sent on with
// its entry as the server sends a stored one.
async function toCodex(id, content, files, extra = {}) {
  const ok = await receiveAttachments(h.workspaceDir, { conversationId: id, content, attachments: files });
  chat(id, ok.content, undefined, { agent: 'researcher', attachmentEntry: ok.entry.id, ...extra });
  return ok;
}
const resultFor = (id, text, since) => arrived((m) => m.type === 'result' && m._conversationId === id && String(m.result || '').includes(text), { since });
const doneAfter = (id, since) => client.waitFor((m) => m.type === 'system' && m.subtype === 'done' && m._conversationId === id, { since, label: 'the turn ends' });

// The params of the one turn/start whose text holds `tag`.
async function turnStartWith(tag) {
  const pick = () => h.readInvocations().filter((i) => i.mode === 'app-server' && i.method === 'turn/start'
    && i.params && [].concat(i.params.input).some((p) => p && p.type === 'text' && String(p.text).includes(tag)));
  assert.ok(await h.waitUntil(() => pick().length > 0, { timeout: 15000 }), `a turn with ${tag} is started`);
  const found = pick();
  assert.strictEqual(found.length, 1, `one turn with ${tag}`);
  return found[0].params;
}
// The thread the conversation's Codex agent was given, once it says so.
async function threadOf(id, since) {
  const init = await arrived((m) => m.type === 'system' && m.subtype === 'init' && m._conversationId === id && m._agent === 'researcher', { since });
  assert.ok(init && typeof init._sessionId === 'string', 'the Codex agent is given a thread');
  return init._sessionId;
}
// A turn's text item, then the items after it, which are `items`.
function textThen(params, items) {
  assert.strictEqual(params.input[0].type, 'text', 'the text item first');
  assert.deepStrictEqual(params.input.slice(1), items, 'then the items');
  return params.input[0].text;
}
const localImage = (id, stored) => ({ type: 'localImage', path: pathOf(id, stored) });
const pdfForm = (stored) => `[Attached PDF you can't read on Codex: ${stored}. Tell the person you can't open PDFs, and ask for a screenshot of the page or its text.]`;
const shownEarlier = (stored) => `[Attached image shown to you earlier in this conversation: ${stored}]`;

// A Claude Code conversation's first message stored with `files`, answered.
async function claudeOpening(id, tag, files) {
  scenario([
    { match: { agent: 'chief-of-staff', promptIncludes: tag }, turn: [{ text: 'Ready.' }] },
    { match: { promptIncludes: '[SYSTEM:' }, turn: [{ text: '<silent>' }] },
  ]);
  const since = client.messages.length;
  chat(id, `${tag} have a look`, files);
  const stored = await arrived((m) => m.type === 'chat_stored' && m.conversationId === id, { since });
  assert.ok(stored, 'the message is stored');
  await doneAfter(id, since);
  return stored;
}
// The Codex specialist briefed with `brief`, until it hands back.
async function brief(id, text) {
  const since = client.messages.length;
  client.send({ type: 'delegate', conversationId: id, targetAgent: 'researcher', context: text });
  const threadId = await threadOf(id, since);
  assert.ok(await arrived((m) => m.type === 'system' && m.subtype === 'agent_switch' && m._conversationId === id
    && m.fromAgent === 'researcher', { since }), 'the specialist hands back');
  return threadId;
}
const lineIn = (content) => content.split('\n').find((l) => l.startsWith('[Attached: '));

// The record's own entry for `session`, or undefined.
function entryOf(id, session) {
  const { sent } = store.readRecord(h.workspaceDir, id);
  return Object.prototype.hasOwnProperty.call(sent, session) ? sent[session] : undefined;
}
// What the base lacks, asserted before a test relies on it.
function needsRecording() {
  let recordSent;
  try {
    ({ recordSent } = require('../../lib/attachments/store.js'));
  } catch (e) { /* asserted below */ }
  assert.strictEqual(typeof recordSent, 'function', 'store.js exports recordSent');
}

describe('a Codex turn carries the items for the files it names', () => {
  test('a conversation on Codex sent a PNG is started with its text item, then the PNG\'s localImage item', async () => {
    const id = h.freshConvoId('codex-png');
    codexAnswers(['PNG-T']);
    h.clearInvocations();
    const since = client.messages.length;
    const ok = await toCodex(id, 'PNG-T what is this', [file('diagram.png', DIAGRAM)]);
    const threadId = await threadOf(id, since);
    assert.ok(await resultFor(id, 'DONE-PNG-T', since), 'the message is answered');
    const params = await turnStartWith('PNG-T');
    assert.strictEqual(params.threadId, threadId, 'on the agent\'s thread');
    const stored = ok.entry.files[0].file;
    const text = textThen(params, [localImage(id, stored)]);
    assert.ok(text.endsWith(ok.content), 'the message as it was stored, its line included');
    assert.ok(fs.readFileSync(params.input[1].path).equals(DIAGRAM), 'the item names the stored copy');
    h.reapConvo(id);
  });

  test('a conversation on Codex sent 2-notes.md is started with its text item, then the file\'s text after its header', async () => {
    const id = h.freshConvoId('codex-notes');
    await receiveAttachments(h.workspaceDir, { conversationId: id, content: 'earlier', attachments: [file('diagram.png', DIAGRAM)] });
    codexAnswers(['NOTES-T']);
    h.clearInvocations();
    const since = client.messages.length;
    const ok = await toCodex(id, 'NOTES-T read these', [file('notes.md', NOTES)]);
    assert.strictEqual(ok.entry.files[0].file, '2-notes.md', 'the second file the conversation stored');
    assert.ok(await resultFor(id, 'DONE-NOTES-T', since), 'the message is answered');
    const text = textThen(await turnStartWith('NOTES-T'), [{ type: 'text', text: `[Text of attached file 2-notes.md]\n${NOTES.toString('utf8')}` }]);
    assert.ok(text.endsWith(ok.content), 'the message as it was stored, its line included');
    h.reapConvo(id);
  });

  test('a Codex specialist whose brief leaves out the PNG\'s line is sent the line and the item', async () => {
    const id = h.freshConvoId('codex-brief-png');
    const stored = await claudeOpening(id, 'SETUP-BP', [file('diagram.png', DIAGRAM)]);
    codexAnswers(['BRIEF-BP']);
    h.clearInvocations();
    await brief(id, 'BRIEF-BP describe the diagram');
    const text = textThen(await turnStartWith('BRIEF-BP'), [localImage(id, stored.entry.files[0].file)]);
    assert.ok(text.includes(lineIn(stored.content)), 'the PNG\'s line');
    assert.ok(text.includes('BRIEF-BP describe the diagram'), 'and the brief as it was written');
    h.reapConvo(id);
  });

  test('a Codex specialist briefed about a PDF from a Claude Code conversation, with its line and without, is sent the PDF form and no item', async () => {
    for (const half of ['L', 'N']) {
      const id = h.freshConvoId(`codex-brief-pdf-${half}`);
      const stored = await claudeOpening(id, `SETUP-B${half}`, [file('report.pdf', REPORT)]);
      const text = half === 'L' ? `BRIEF-B${half} read this ${lineIn(stored.content)}` : `BRIEF-B${half} read the report`;
      codexAnswers([`BRIEF-B${half}`]);
      h.clearInvocations();
      await brief(id, text);
      const params = await turnStartWith(`BRIEF-B${half}`);
      const sent = textThen(params, []);
      assert.ok(sent.includes(pdfForm(stored.entry.files[0].file)), 'the PDF form');
      assert.ok(!JSON.stringify(params).includes('.rundock/attachments/'), 'and no path is given');
      h.reapConvo(id);
    }
  });

  test('the fresh-thread fallback\'s full first-turn prompt carries the message\'s line and its item', async () => {
    const id = h.freshConvoId('codex-fallback');
    codexAnswers(['FALLBACK-T'], { resumeFails: true });
    h.clearInvocations();
    const since = client.messages.length;
    const ok = await toCodex(id, 'FALLBACK-T look', [file('diagram.png', DIAGRAM)], { sessionId: 'thread-gone-t' });
    assert.ok(await resultFor(id, 'DONE-FALLBACK-T', since), 'the message is answered');
    const text = textThen(await turnStartWith('FALLBACK-T'), [localImage(id, ok.entry.files[0].file)]);
    assert.ok(text.includes('You are Ida') && text.includes('PLATFORM RULES'), 'the full first-turn prompt');
    assert.ok(text.endsWith(ok.content), 'with the message and its line');
    h.reapConvo(id);
  });

  test('a Codex specialist briefed again with a line for an image its thread was sent is given the shown-earlier form', async () => {
    const id = h.freshConvoId('codex-rebrief');
    const stored = await claudeOpening(id, 'SETUP-BR', [file('diagram.png', DIAGRAM)]);
    codexAnswers(['BRIEF-BR1', 'BRIEF-BR2']);
    h.clearInvocations();
    const threadId = await brief(id, 'BRIEF-BR1 describe the diagram');
    seedRecord(id, { agentId: 'chief-of-staff', sessionIds: [{ agentId: 'researcher', sessionId: threadId }] });
    const line = lineIn(stored.content);
    assert.strictEqual(await brief(id, `BRIEF-BR2 look again at ${line}`), threadId, 'the specialist\'s thread is resumed');
    const params = await turnStartWith('BRIEF-BR2');
    const text = textThen(params, []);
    assert.ok(text.includes(`BRIEF-BR2 look again at ${shownEarlier(stored.entry.files[0].file)}`), 'the shown-earlier form');
    assert.ok(!JSON.stringify(params).includes('.rundock/attachments/'), 'and no path is given');
    h.reapConvo(id);
  });
});

describe('the text-only turns at both Codex sites, as they always were', () => {
  const delegated = 'DELEGATION CONTEXT:\nYou have been delegated a task by another agent. Complete the task fully in this single response; you cannot wait for follow-up messages in this session. Prefer sensible defaults over asking questions. When the task is done, post your final summary and output <!-- RUNDOCK:COMPLETE --> at the very end of the response. If you genuinely cannot proceed without an answer from the user, state the question clearly in your response and still output <!-- RUNDOCK:COMPLETE -->; the reply will reach you when the task is re-delegated. Only use <!-- RUNDOCK:RETURN --> if the request is genuinely outside your scope and you cannot help. If your own part is finished but the request still needs something to happen next, for example work that belongs to another specialist, output <!-- RUNDOCK:CONTINUE --> instead of COMPLETE: COMPLETE means nothing remains to be done.';
  function freshBrief(catchUp, text) {
    const agent = h.internal.discoverAgents().find((a) => a.id === 'researcher');
    return ['You are Ida, the researcher.', h.internal.buildSystemPrompt(agent), delegated, `${catchUp}[DELEGATION BRIEF]\n${text}`].join('\n\n');
  }
  const arrival = (...turns) => `THE CONVERSATION SO FAR, BEFORE YOU JOINED:\n${turns.join('\n\n')}\n\n`;
  const plain = (params, threadId, text) => assert.deepStrictEqual(params, { threadId, input: [{ type: 'text', text }] }, 'one text item, the input it always was');

  test('a specialist\'s text-only brief and a Codex conversation\'s text-only follow-up are each one text item, byte for byte', async () => {
    const briefed = h.freshConvoId('codex-plain-b');
    scenario([
      { match: { agent: 'chief-of-staff', promptIncludes: 'SETUP-BT' }, turn: [{ text: 'Ready.' }] },
      { match: { promptIncludes: '[SYSTEM:' }, turn: [{ text: '<silent>' }] },
    ]);
    codexAnswers(['BRIEF-BT', 'OPEN-TT', 'PLAIN-TT']);
    h.clearInvocations();
    chat(briefed, 'SETUP-BT');
    await client.waitForEvent('system', 'done', briefed);
    const briefThread = await brief(briefed, 'BRIEF-BT find two');
    plain(await turnStartWith('BRIEF-BT'), briefThread, freshBrief(arrival('USER: SETUP-BT', 'COS: Ready.'), 'BRIEF-BT find two'));
    h.reapConvo(briefed);

    const direct = h.freshConvoId('codex-plain-t');
    const since = client.messages.length;
    chat(direct, 'OPEN-TT hello', undefined, { agent: 'researcher' });
    const threadId = await threadOf(direct, since);
    assert.ok(await resultFor(direct, 'DONE-OPEN-TT', since), 'the first message is answered');
    await doneAfter(direct, since);
    const at = client.messages.length;
    chat(direct, 'PLAIN-TT just words', undefined, { agent: 'researcher', sessionId: threadId });
    assert.ok(await resultFor(direct, 'DONE-PLAIN-TT', at), 'the text is answered');
    plain(await turnStartWith('PLAIN-TT'), threadId, 'PLAIN-TT just words');
    h.reapConvo(direct);
  });
});

describe('what a Codex send records', () => {
  test('a Codex turn is recorded under its thread with the app-server\'s instance', async () => {
    needsRecording();
    const id = h.freshConvoId('codex-record');
    codexAnswers(['RECORD-T']);
    h.clearInvocations();
    const since = client.messages.length;
    const ok = await toCodex(id, 'RECORD-T keep this', [file('diagram.png', DIAGRAM), file('notes.md', NOTES)]);
    const threadId = await threadOf(id, since);
    assert.ok(await resultFor(id, 'DONE-RECORD-T', since), 'the message is answered');
    const { instance, ...rest } = entryOf(id, threadId) || {};
    assert.deepStrictEqual(rest, { files: [ok.entry.files[0].file], bytes: DIAGRAM.length, images: 1 }, 'the PNG alone, the inline text recorded nowhere');
    assert.match(String(instance), /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, 'with the instance the thread was opened on');
    h.reapConvo(id);
  });

  test('a startTurn that throws records nothing', async () => {
    needsRecording();
    const id = h.freshConvoId('codex-throws');
    codexAnswers(['THROWS-T']);
    h.clearInvocations();
    const server = await glue.getCodexAppServer();
    const startTurn = server.startTurn;
    // A bad item after the turn's own, so startTurn's check throws.
    server.startTurn = function (threadId, text, opts, items) {
      return startTurn.call(this, threadId, text, opts, [...items, { type: 'localImage', path: 'diagram.png' }]);
    };
    try {
      const since = client.messages.length;
      await toCodex(id, 'THROWS-T look', [file('diagram.png', DIAGRAM)]);
      const threadId = await threadOf(id, since);
      assert.ok(await arrived((m) => m.type === 'system' && m.subtype === 'codex_error' && m._conversationId === id, { since }), 'the turn fails to start');
      await doneAfter(id, since);
      assert.strictEqual(entryOf(id, threadId), undefined, 'nothing is recorded for the thread');
      assert.deepStrictEqual(h.readInvocations().filter((i) => i.method === 'turn/start'), [], 'and no turn is started');
    } finally {
      server.startTurn = startTurn;
    }
    h.reapConvo(id);
  });
});

describe('a thread resumed on another app-server process is sent its images again', () => {
  const recordFile = (id) => path.join(h.workspaceDir, '.rundock', 'attachments', id, 'record.json');
  // The thread's entry as another process left it.
  function entryFrom(id, threadId, entry) {
    const record = JSON.parse(fs.readFileSync(recordFile(id), 'utf8'));
    record.sent = { ...record.sent, [threadId]: { ...entry, instance: 'another-process' } };
    fs.writeFileSync(recordFile(id), JSON.stringify(record));
  }
  const linesIn = (content) => content.split('\n').filter((l) => l.startsWith('[Attached: '));
  // A conversation on Codex sent `files`, its first turn ended. Without its
  // line, the message names its files through its entry alone.
  async function opening(id, tag, files, { withLine = true } = {}) {
    const since = client.messages.length;
    const content = `${tag} have a look`;
    const ok = await receiveAttachments(h.workspaceDir, { conversationId: id, content, attachments: files });
    chat(id, withLine ? ok.content : content, undefined, { agent: 'researcher', attachmentEntry: ok.entry.id });
    const threadId = await threadOf(id, since);
    await doneAfter(id, since);
    return { ok, threadId, stored: ok.entry.files.map((f) => f.file) };
  }
  // A follow-up with no files on `threadId`, once it ends.
  async function followUp(id, threadId, content) {
    const since = client.messages.length;
    chat(id, content, undefined, { agent: 'researcher', sessionId: threadId });
    await doneAfter(id, since);
  }

  test('a follow-up with no files after a PNG, on the same app-server, carries no localImage item', async () => {
    const id = h.freshConvoId('codex-warm');
    codexAnswers(['WARM-TA', 'WARM-TB']);
    h.clearInvocations();
    const { threadId } = await opening(id, 'WARM-TA', [file('diagram.png', DIAGRAM)], { withLine: false });
    await followUp(id, threadId, 'WARM-TB and the next step?');
    const params = await turnStartWith('WARM-TB');
    assert.deepStrictEqual(params, { threadId, input: [{ type: 'text', text: 'WARM-TB and the next step?' }] }, 'the person\'s text alone');
    h.reapConvo(id);
  });

  test('a follow-up on the same app-server naming the PNG\'s line is given the shown-earlier form', async () => {
    const id = h.freshConvoId('codex-warm-line');
    codexAnswers(['WARM-TC', 'WARM-TD']);
    h.clearInvocations();
    const { ok, threadId, stored } = await opening(id, 'WARM-TC', [file('diagram.png', DIAGRAM)]);
    await followUp(id, threadId, `WARM-TD the left half of ${lineIn(ok.content)}`);
    const text = textThen(await turnStartWith('WARM-TD'), []);
    assert.strictEqual(text, `WARM-TD the left half of ${shownEarlier(stored[0])}`, 'the shown-earlier form');
    h.reapConvo(id);
  });

  test('a follow-up after the app-server respawned resumes the thread and carries the PNG\'s line and item after the person\'s text', async () => {
    const id = h.freshConvoId('codex-respawn');
    h.writeCodexScenario([
      { match: { promptIncludes: 'CRASH-TB' }, deltas: ['about to die'], crashMidTurn: true },
      ...['CRASH-TA', 'CRASH-TC'].map((tag) => ({ match: { promptIncludes: tag }, text: `DONE-${tag}` })),
    ]);
    h.clearInvocations();
    const { ok, threadId, stored } = await opening(id, 'CRASH-TA', [file('diagram.png', DIAGRAM)]);
    let since = client.messages.length;
    chat(id, 'CRASH-TB crash now', undefined, { agent: 'researcher', sessionId: threadId });
    assert.ok(await arrived((m) => m.type === 'system' && m.subtype === 'codex_error' && m._conversationId === id, { since }), 'the turn dies with the app-server');
    await doneAfter(id, since);
    since = client.messages.length;
    chat(id, 'CRASH-TC are you there?', undefined, { agent: 'researcher', sessionId: threadId });
    assert.ok(await resultFor(id, 'DONE-CRASH-TC', since), 'the follow-up is answered on the respawned app-server');
    const params = await turnStartWith('CRASH-TC');
    assert.strictEqual(params.threadId, threadId, 'the same thread, resumed');
    const text = textThen(params, [localImage(id, stored[0])]);
    assert.strictEqual(text, `CRASH-TC are you there?\n${lineIn(ok.content)}`, 'the PNG\'s line after the person\'s text');
    await doneAfter(id, since);
    h.reapConvo(id);
  });

  test('a thread whose entry names another app-server instance is sent its PNG again', async () => {
    const id = h.freshConvoId('codex-other');
    codexAnswers(['OTHER-TA', 'OTHER-TB']);
    h.clearInvocations();
    const { ok, threadId, stored } = await opening(id, 'OTHER-TA', [file('diagram.png', DIAGRAM)]);
    entryFrom(id, threadId, { files: stored, bytes: DIAGRAM.length, images: 1 });
    await followUp(id, threadId, 'OTHER-TB and now?');
    const text = textThen(await turnStartWith('OTHER-TB'), [localImage(id, stored[0])]);
    assert.strictEqual(text, `OTHER-TB and now?\n${lineIn(ok.content)}`, 'the PNG\'s line after the person\'s text');
    h.reapConvo(id);
  });

  test('a PNG deleted before a cold resume is left out, and no path is given', async () => {
    const id = h.freshConvoId('codex-gone');
    codexAnswers(['GONE-TA', 'GONE-TB']);
    h.clearInvocations();
    const { threadId, stored } = await opening(id, 'GONE-TA', [file('diagram.png', DIAGRAM)]);
    textThen(await turnStartWith('GONE-TA'), [localImage(id, stored[0])]);
    entryFrom(id, threadId, { files: stored, bytes: DIAGRAM.length, images: 1 });
    fs.unlinkSync(pathOf(id, stored[0]));
    await followUp(id, threadId, 'GONE-TB still there?');
    const params = await turnStartWith('GONE-TB');
    assert.deepStrictEqual(params, { threadId, input: [{ type: 'text', text: 'GONE-TB still there?' }] }, 'the person\'s text alone');
    assert.ok(!JSON.stringify(params).includes('.rundock/attachments/'), 'and no path is given');
    h.reapConvo(id);
  });

  test('three images sent earlier are sent again on a cold resume, last listed first', async () => {
    const id = h.freshConvoId('codex-three');
    codexAnswers(['THREE-TA', 'THREE-TB']);
    h.clearInvocations();
    const images = [png(640, 480, 40), png(800, 600, 50), png(320, 240, 60)];
    const { ok, threadId, stored } = await opening(id, 'THREE-TA',
      [file('diagram.png', images[0]), file('chart.png', images[1]), file('sketch.png', images[2])]);
    entryFrom(id, threadId, { files: stored, bytes: 150, images: 3 });
    await followUp(id, threadId, 'THREE-TB compare them');
    const lines = linesIn(ok.content);
    const text = textThen(await turnStartWith('THREE-TB'), [2, 1, 0].map((i) => localImage(id, stored[i])));
    assert.strictEqual(text, ['THREE-TB compare them', lines[2], lines[1], lines[0]].join('\n'), 'their lines in the same order');
    h.reapConvo(id);
  });

  test('the fresh-thread fallback after a PNG resends nothing', async () => {
    const id = h.freshConvoId('codex-fresh');
    codexAnswers(['FRESH-TA', 'FRESH-TB'], { resumeFails: true });
    h.clearInvocations();
    const { threadId } = await opening(id, 'FRESH-TA', [file('diagram.png', DIAGRAM)], { withLine: false });
    await followUp(id, threadId, 'FRESH-TB one more thing');
    const params = await turnStartWith('FRESH-TB');
    assert.notStrictEqual(params.threadId, threadId, 'a fresh thread');
    assert.strictEqual(params.input.length, 1, 'one text item');
    assert.ok(params.input[0].text.includes('You are Ida') && params.input[0].text.endsWith('\n\nFRESH-TB one more thing'), 'the full first-turn prompt');
    h.reapConvo(id);
  });

  test('after a cold resume the thread\'s entry holds the new instance and this turn\'s files alone', async () => {
    needsRecording();
    const id = h.freshConvoId('codex-replaced');
    codexAnswers(['AFTER-TA', 'AFTER-TB']);
    h.clearInvocations();
    const chart = png(800, 600, 50);
    const { threadId, stored } = await opening(id, 'AFTER-TA', [file('diagram.png', DIAGRAM), file('chart.png', chart)]);
    entryFrom(id, threadId, { files: stored, bytes: DIAGRAM.length + chart.length, images: 2 });
    fs.unlinkSync(pathOf(id, stored[1]));
    await followUp(id, threadId, 'AFTER-TB the first one');
    const { instance, ...rest } = entryOf(id, threadId) || {};
    assert.deepStrictEqual(rest, { files: [stored[0]], bytes: DIAGRAM.length, images: 1 }, 'this turn\'s copy alone');
    assert.match(String(instance), /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, 'with the instance it was sent through');
    h.reapConvo(id);
  });

  // The thread's entry as an agent could leave it, written as given.
  function plantEntry(id, threadId, entry) {
    const record = JSON.parse(fs.readFileSync(recordFile(id), 'utf8'));
    record.sent = { ...record.sent, [threadId]: entry };
    fs.writeFileSync(recordFile(id), JSON.stringify(record));
  }

  test('a thread whose entry names no instance is sent its PNG again', async () => {
    const id = h.freshConvoId('codex-no-instance');
    codexAnswers(['BARE-TA', 'BARE-TB']);
    h.clearInvocations();
    const { ok, threadId, stored } = await opening(id, 'BARE-TA', [file('diagram.png', DIAGRAM)]);
    plantEntry(id, threadId, { files: stored, bytes: DIAGRAM.length, images: 1 });
    await followUp(id, threadId, 'BARE-TB and now?');
    const text = textThen(await turnStartWith('BARE-TB'), [localImage(id, stored[0])]);
    assert.strictEqual(text, `BARE-TB and now?\n${lineIn(ok.content)}`, 'the PNG\'s line after the person\'s text');
    h.reapConvo(id);
  });

  test('a thread with no entry is sent nothing again when it is resumed', async () => {
    const id = h.freshConvoId('codex-no-entry');
    codexAnswers(['NONE-TA', 'NONE-TB']);
    h.clearInvocations();
    const since = client.messages.length;
    chat(id, 'NONE-TA hello', undefined, { agent: 'researcher' });
    const threadId = await threadOf(id, since);
    await doneAfter(id, since);
    // A PNG the conversation keeps that this thread was never sent.
    await receiveAttachments(h.workspaceDir, { conversationId: id, content: 'for another agent', attachments: [file('diagram.png', DIAGRAM)] });
    assert.strictEqual(entryOf(id, threadId), undefined, 'the thread has no entry');
    await followUp(id, threadId, 'NONE-TB anything new?');
    const params = await turnStartWith('NONE-TB');
    assert.deepStrictEqual(params, { threadId, input: [{ type: 'text', text: 'NONE-TB anything new?' }] }, 'the person\'s text alone');
    h.reapConvo(id);
  });

  test('a Codex turn is recorded with its app-server process\'s instance, the same on a follow-up to that process and a new one once it respawns', async () => {
    needsRecording();
    const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    const id = h.freshConvoId('codex-instance');
    h.writeCodexScenario([
      { match: { promptIncludes: 'INST-TC' }, deltas: ['about to die'], crashMidTurn: true },
      ...['INST-TA', 'INST-TB', 'INST-TD'].map((tag) => ({ match: { promptIncludes: tag }, text: `DONE-${tag}` })),
    ]);
    h.clearInvocations();
    const { threadId } = await opening(id, 'INST-TA', [file('diagram.png', DIAGRAM)]);
    const first = (entryOf(id, threadId) || {}).instance;
    assert.match(String(first), UUID, 'the thread is recorded with the instance it was opened on');
    await followUp(id, threadId, 'INST-TB on the same process');
    assert.strictEqual((entryOf(id, threadId) || {}).instance, first, 'a follow-up to the same process keeps it');
    let since = client.messages.length;
    chat(id, 'INST-TC crash now', undefined, { agent: 'researcher', sessionId: threadId });
    assert.ok(await arrived((m) => m.type === 'system' && m.subtype === 'codex_error' && m._conversationId === id, { since }), 'the turn dies with the app-server');
    await doneAfter(id, since);
    since = client.messages.length;
    chat(id, 'INST-TD after the respawn', undefined, { agent: 'researcher', sessionId: threadId });
    assert.ok(await resultFor(id, 'DONE-INST-TD', since), 'the follow-up is answered on the respawned app-server');
    await doneAfter(id, since);
    const second = (entryOf(id, threadId) || {}).instance;
    assert.match(String(second), UUID, 'recorded with the respawned process\'s instance');
    assert.notStrictEqual(second, first, 'which is a new one');
    h.reapConvo(id);
  });
});

describe('what a Claude Code session is recorded as sent', () => {
  // Each tag answered `DONE-<tag>` by the stub Claude.
  const claudeAnswers = (tags, dead = [], extra = {}) => scenario(tags.map((tag) => ({ match: { promptIncludes: tag }, turn: [{ text: `DONE-${tag}` }] })), dead, extra);
  const storedFor = (id, since) => arrived((m) => m.type === 'chat_stored' && m.conversationId === id, { since });
  const spawnsFor = (id) => h.readInvocations().filter((i) => i.env && i.env.RUNDOCK_CONVO_ID === id);
  const blockOf = (bytes) => ({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: bytes.toString('base64') } });
  const filesOf = (stored) => stored.entry.files.map((f) => f.file);
  // The session the conversation's process reported at init.
  async function sessionOf(id, since) {
    const init = await arrived((m) => m.type === 'system' && m.subtype === 'init' && m._conversationId === id, { since });
    assert.ok(init && typeof init._sessionId === 'string', 'the process reports its session');
    return init._sessionId;
  }
  // The one stdin line read for a turn whose text holds `tag`, its content
  // parsed.
  async function readWith(tag) {
    const pick = () => h.readPrompts().filter((p) => p.line !== undefined && p.prompt.includes(tag));
    assert.ok(await h.waitUntil(() => pick().length > 0, { timeout: 15000 }), `a turn with ${tag} is read`);
    const found = pick();
    assert.strictEqual(found.length, 1, `one turn with ${tag}`);
    return { resume: found[0].resume || null, content: JSON.parse(found[0].line).message.content };
  }
  // A Claude Code conversation's earlier message holding the diagram, which
  // `session` was sent, and the conversation listed as resuming it.
  async function sentBefore(id, tag, session) {
    const first = await receiveAttachments(h.workspaceDir, { conversationId: id, content: `${tag} the diagram`, attachments: [file('diagram.png', DIAGRAM)] });
    assert.strictEqual(store.recordSent(h.workspaceDir, id, session, { files: filesOf(first), bytes: DIAGRAM.length, images: 1 }), true);
    seedRecord(id, { agentId: 'chief-of-staff', sessionId: session, sessionIds: [{ agentId: 'chief-of-staff', sessionId: session }] });
    return first;
  }

  test('a new process records what it was sent under the ID init reports, and a later send at once', async () => {
    needsRecording();
    const id = h.freshConvoId('claude-new');
    claudeAnswers(['NEW-C1', 'NEW-C2']);
    h.clearInvocations();
    const since = client.messages.length;
    chat(id, 'NEW-C1 have a look', [file('diagram.png', DIAGRAM)]);
    const stored = await storedFor(id, since);
    assert.ok(stored, 'the message is stored');
    const session = await sessionOf(id, since);
    assert.ok(await resultFor(id, 'DONE-NEW-C1', since), 'the first turn is answered');
    assert.deepStrictEqual((await readWith('NEW-C1')).content.slice(1), [blockOf(DIAGRAM)], 'the first turn carries the block');
    assert.deepStrictEqual(entryOf(id, session), { files: filesOf(stored), bytes: DIAGRAM.length, images: 1 }, 'recorded under the reported ID');
    const chart = png(800, 600, 50);
    const next = client.messages.length;
    chat(id, 'NEW-C2 and this', [file('chart.png', chart)], { sessionId: session });
    const more = await storedFor(id, next);
    assert.ok(await resultFor(id, 'DONE-NEW-C2', next), 'the follow-up is answered');
    assert.deepStrictEqual(entryOf(id, session), { files: [...filesOf(stored), ...filesOf(more)], bytes: DIAGRAM.length + chart.length, images: 2 });
    h.reapConvo(id);
  });

  test('a resume reported under a new ID starts it from the resumed session\'s totals and files', async () => {
    needsRecording();
    const id = h.freshConvoId('claude-resumed');
    const resumed = 'live-resume-c';
    const first = await sentBefore(id, 'RES-C0', resumed);
    claudeAnswers(['RES-C1', 'RES-C2'], [], { newSessionOnResume: true });
    h.clearInvocations();
    const chart = png(800, 600, 50);
    const since = client.messages.length;
    chat(id, 'RES-C1 and this', [file('chart.png', chart)], { sessionId: resumed });
    const stored = await storedFor(id, since);
    assert.ok(stored, 'the message is stored');
    const session = await sessionOf(id, since);
    assert.notStrictEqual(session, resumed, 'the resume is reported under a new ID');
    assert.ok(await resultFor(id, 'DONE-RES-C1', since), 'the resumed turn is answered');
    assert.deepStrictEqual(spawnsFor(id).map((i) => i.resume), [resumed], 'started to resume');
    assert.deepStrictEqual((await readWith('RES-C1')).content.slice(1), [blockOf(chart)], 'the new file\'s block alone');
    assert.deepStrictEqual(entryOf(id, session), { files: [...filesOf(first), ...filesOf(stored)], bytes: DIAGRAM.length + chart.length, images: 2 },
      'the resumed totals and files, then this turn\'s');
    assert.deepStrictEqual(entryOf(id, resumed), { files: filesOf(first), bytes: DIAGRAM.length, images: 1 }, 'the resumed entry as it was');
    const again = `RES-C2 that first one again\n${lineIn(first.content)}`;
    const next = client.messages.length;
    chat(id, again, undefined, { sessionId: session, attachmentEntry: first.entry.id });
    assert.ok(await resultFor(id, 'DONE-RES-C2', next), 'the follow-up is answered');
    assert.strictEqual((await readWith('RES-C2')).content, again, 'its line alone');
    h.reapConvo(id);
  });

  test('a process that exits before init records nothing, and the next one is sent the file again', async () => {
    needsRecording();
    const id = h.freshConvoId('claude-exited');
    scenario([
      { match: { promptIncludes: 'GONE-C1' }, crash: 1 },
      { match: { promptIncludes: 'GONE-C2' }, turn: [{ text: 'DONE-GONE-C2' }] },
    ]);
    h.clearInvocations();
    const since = client.messages.length;
    chat(id, 'GONE-C1 have a look', [file('diagram.png', DIAGRAM)]);
    const stored = await storedFor(id, since);
    assert.ok(stored, 'the message is stored');
    await doneAfter(id, since);
    assert.ok(!client.messages.slice(since).some((m) => m.subtype === 'init' && m._conversationId === id), 'no session is reported');
    assert.deepStrictEqual(store.readRecord(h.workspaceDir, id).sent, {}, 'nothing is recorded');
    const again = `GONE-C2 again\n${lineIn(stored.content)}`;
    const next = client.messages.length;
    chat(id, again, undefined, { attachmentEntry: stored.entry.id });
    const session = await sessionOf(id, next);
    assert.ok(await resultFor(id, 'DONE-GONE-C2', next), 'the next process answers');
    assert.deepStrictEqual((await readWith('GONE-C2')).content, [{ type: 'text', text: again }, blockOf(DIAGRAM)], 'sent the block again');
    assert.deepStrictEqual(store.readRecord(h.workspaceDir, id).sent, { [session]: { files: filesOf(stored), bytes: DIAGRAM.length, images: 1 } });
    h.reapConvo(id);
  });

  test('a session started fresh after a lost one has no entry of its own, so it is sent the files the lost one was', async () => {
    needsRecording();
    const id = h.freshConvoId('claude-lost');
    const lost = 'dead-lost-c';
    const first = await sentBefore(id, 'LOST-C0', lost);
    claudeAnswers(['LOST-C1'], [lost]);
    h.clearInvocations();
    const since = client.messages.length;
    chat(id, `LOST-C1 that one again\n${lineIn(first.content)}`, undefined, { sessionId: lost, attachmentEntry: first.entry.id });
    const session = await sessionOf(id, since);
    assert.ok(await resultFor(id, 'DONE-LOST-C1', since), 'the fresh start answers');
    assert.deepStrictEqual(spawnsFor(id).map((i) => i.resume), [lost, null], 'refused, then started fresh');
    const sent = await readWith('LOST-C1');
    assert.strictEqual(sent.resume, null, 'read by the fresh start');
    assert.deepStrictEqual(sent.content.slice(1), [blockOf(DIAGRAM)], 'sent the block the lost session was');
    const once = { files: filesOf(first), bytes: DIAGRAM.length, images: 1 };
    assert.deepStrictEqual(store.readRecord(h.workspaceDir, id).sent, { [lost]: once, [session]: once });
    h.reapConvo(id);
  });

  test('a legacy start records what it was sent under the ID its process reports', async () => {
    needsRecording();
    const id = h.freshConvoId('claude-legacy');
    claudeAnswers(['LEGACY-C1']);
    h.clearInvocations();
    const since = client.messages.length;
    let stored;
    let session;
    process.env.RUNDOCK_LEGACY_SPAWN = '1';
    try {
      chat(id, 'LEGACY-C1 have a look', [file('diagram.png', DIAGRAM)]);
      stored = await storedFor(id, since);
      assert.ok(stored, 'the message is stored');
      session = await sessionOf(id, since);
      assert.ok(await resultFor(id, 'DONE-LEGACY-C1', since), 'the turn is answered');
    } finally {
      delete process.env.RUNDOCK_LEGACY_SPAWN;
    }
    assert.deepStrictEqual(spawnsFor(id).map((i) => i.print), [true], 'by a process started in legacy mode');
    assert.deepStrictEqual((await readWith('LEGACY-C1')).content.slice(1), [blockOf(DIAGRAM)], 'the turn carries the block');
    assert.deepStrictEqual(store.readRecord(h.workspaceDir, id).sent, { [session]: { files: filesOf(stored), bytes: DIAGRAM.length, images: 1 } },
      'recorded under the reported ID');
    h.reapConvo(id);
  });

  test('a brief handed to a delegate records what it was sent under the ID the delegate\'s process reports', async () => {
    needsRecording();
    const id = h.freshConvoId('claude-handover');
    scenario([
      { match: { agent: 'chief-of-staff', promptIncludes: 'HANDOVER-C1', promptExcludes: '[SYSTEM:' },
        turn: [{ agentTool: { subagent_type: 'content-lead', prompt: 'BRIEF-HC do it' } }] },
      { match: { agent: 'content-lead', promptIncludes: 'BRIEF-HC' }, turn: [{ text: 'Handed back.' }] },
      { match: { promptIncludes: '[SYSTEM:' }, turn: [{ text: '<silent>' }] },
    ]);
    h.clearInvocations();
    const since = client.messages.length;
    chat(id, 'HANDOVER-C1 have a look', [file('diagram.png', DIAGRAM)]);
    const stored = await storedFor(id, since);
    assert.ok(stored, 'the message is stored');
    const initOf = (agent) => arrived((m) => m.type === 'system' && m.subtype === 'init' && m._conversationId === id && m._agent === agent, { since });
    const lead = await initOf('chief-of-staff');
    const delegate = await initOf('content-lead');
    assert.ok(lead && delegate && typeof delegate._sessionId === 'string', 'the leader and the delegate each report a session');
    assert.notStrictEqual(delegate._sessionId, lead._sessionId, 'two sessions');
    const pick = () => h.readPrompts().filter((p) => p.agent === 'content-lead' && p.line !== undefined && p.prompt.includes('BRIEF-HC'));
    assert.ok(await h.waitUntil(() => pick().length > 0, { timeout: 15000 }), 'the delegate reads its brief');
    assert.strictEqual(pick().length, 1, 'once');
    assert.deepStrictEqual(JSON.parse(pick()[0].line).message.content.slice(1), [blockOf(DIAGRAM)], 'the brief carries the block');
    const once = { files: filesOf(stored), bytes: DIAGRAM.length, images: 1 };
    assert.deepStrictEqual(store.readRecord(h.workspaceDir, id).sent, { [lead._sessionId]: once, [delegate._sessionId]: once },
      'each session recorded under the ID its process reported');
    h.reapConvo(id);
  });
});

describe('what the server stores and refuses for an agent on Codex', () => {
  const PDF_TEXT = 'This agent runs on Codex, which can\'t read PDFs yet. Attach a screenshot of the page or paste the text.';
  const IMAGES_TEXT = 'This agent runs on Codex, and Rundock sends a Codex agent at most 20 images or 10 MB of images in one conversation. Remove an image or start a new conversation.';
  const folderOf = (id) => path.join(h.workspaceDir, '.rundock', 'attachments', id);
  // Each file in the conversation's folder by name, with its bytes; null when
  // there is no folder.
  function bytesIn(id) {
    let names;
    try { names = fs.readdirSync(folderOf(id)).sort(); } catch (e) { return null; }
    return Object.fromEntries(names.map((n) => [n, fs.readFileSync(path.join(folderOf(id), n))]));
  }
  const turnStarts = () => h.readInvocations().filter((i) => i.mode === 'app-server' && i.method === 'turn/start').length;
  const shots = (n, size = 33, from = 1) => Array.from({ length: n }, (_, i) => file(`shot-${from + i}.png`, png(10, 10, size)));
  const toResearcher = (id, content, attachments, extra = {}) => chat(id, content, attachments, { agent: 'researcher', ...extra });
  const storedFor = (id, since) => arrived((m) => m.type === 'chat_stored' && m.conversationId === id, { since });
  // A message sent to the researcher with `attachments`, stored and answered.
  // Returns its chat_stored and the thread it went to.
  async function storedAndAnswered(id, tag, attachments, extra = {}) {
    const since = client.messages.length;
    toResearcher(id, `${tag} have a look`, attachments, extra);
    const stored = await storedFor(id, since);
    assert.ok(stored, `${tag} is stored`);
    const threadId = extra.sessionId || await threadOf(id, since);
    assert.ok(await resultFor(id, `DONE-${tag}`, since), `${tag} is answered`);
    await doneAfter(id, since);
    return { stored, threadId };
  }
  // Twenty small images over four turns on one thread, each turn answered.
  async function twentyOver4Turns(id, tag) {
    const tags = [1, 2, 3, 4].map((n) => `${tag}-${n}`);
    codexAnswers(tags);
    const first = await storedAndAnswered(id, tags[0], shots(5, 33, 1));
    for (const [i, t] of tags.slice(1).entries()) {
      await storedAndAnswered(id, t, shots(5, 33, 6 + i * 5), { sessionId: first.threadId });
    }
    return first.threadId;
  }
  // `msg` refused with `wording` and `code`: one chat_refused, no chat_stored,
  // the folder and record byte for byte as before, and no turn/start.
  async function refusedAsBefore(msg, { code, title, text }) {
    const before = bytesIn(msg.conversationId);
    const turns = turnStarts();
    const since = client.messages.length;
    client.send({ type: 'chat', ...msg });
    const got = await arrived((m) => m.type === 'chat_refused' && m.conversationId === msg.conversationId, { since });
    assert.ok(got, 'the message is answered with chat_refused');
    await h.delay(300);
    const answered = client.messages.slice(since).filter((m) => m.conversationId === msg.conversationId);
    assert.strictEqual(answered.filter((m) => m.type === 'chat_refused').length, 1, 'one chat_refused');
    assert.ok(!answered.some((m) => m.type === 'chat_stored'), 'and no chat_stored');
    assert.deepStrictEqual({ code: got.code, title: got.title, text: got.text }, { code, title, text });
    assert.deepStrictEqual(bytesIn(msg.conversationId), before, 'the folder and record byte for byte as before');
    assert.strictEqual(turnStarts(), turns, 'no turn/start');
    return got;
  }

  test('a PDF for an agent on Codex is refused codex-pdf, naming it', async () => {
    const id = h.freshConvoId('codex-pdf');
    const got = await refusedAsBefore({ conversationId: id, agent: 'researcher', content: 'PDF-S read this', attachments: [file('report.pdf', REPORT)] },
      { code: 'codex-pdf', title: 'report.pdf', text: PDF_TEXT });
    assert.strictEqual(got.name, 'report.pdf');
    h.reapConvo(id);
  });

  test('a PDF with two PNGs is refused codex-pdf, naming the PDF, and sent again without it is stored once', async () => {
    const id = h.freshConvoId('codex-pdf-pngs');
    const attachments = [file('diagram.png', DIAGRAM), file('report.pdf', REPORT), file('chart.png', png(800, 600, 50))];
    await refusedAsBefore({ conversationId: id, agent: 'researcher', content: 'RETRY-S look', attachments },
      { code: 'codex-pdf', title: 'report.pdf', text: PDF_TEXT });
    codexAnswers(['RETRY-S']);
    const since = client.messages.length;
    const { stored } = await storedAndAnswered(id, 'RETRY-S', [attachments[0], attachments[2]]);
    assert.strictEqual(client.messages.slice(since).filter((m) => m.type === 'chat_stored' && m.conversationId === id).length, 1, 'one chat_stored');
    assert.deepStrictEqual(store.readRecord(h.workspaceDir, id).messages, [stored.entry], 'one record entry');
    assert.deepStrictEqual(Object.keys(bytesIn(id)), ['1-diagram.png', '2-chart.png', 'record.json']);
    h.reapConvo(id);
  });

  test('a PNG for an agent on Codex is stored with one chat_stored, and its turn/start carries the localImage item', async () => {
    const id = h.freshConvoId('codex-png-stored');
    codexAnswers(['STORED-S']);
    h.clearInvocations();
    const since = client.messages.length;
    const { stored } = await storedAndAnswered(id, 'STORED-S', [file('diagram.png', DIAGRAM)]);
    assert.strictEqual(client.messages.slice(since).filter((m) => m.type === 'chat_stored' && m.conversationId === id).length, 1, 'one chat_stored');
    textThen(await turnStartWith('STORED-S'), [localImage(id, stored.entry.files[0].file)]);
    h.reapConvo(id);
  });

  test('a Markdown file for an agent on Codex is stored and sent as its text', async () => {
    const id = h.freshConvoId('codex-md');
    codexAnswers(['MD-S']);
    h.clearInvocations();
    await storedAndAnswered(id, 'MD-S', [file('notes.md', NOTES)]);
    textThen(await turnStartWith('MD-S'), [{ type: 'text', text: `[Text of attached file 1-notes.md]\n${NOTES.toString('utf8')}` }]);
    h.reapConvo(id);
  });

  test('a PDF for a Claude Code agent is stored and given its block', async () => {
    const id = h.freshConvoId('claude-pdf');
    scenario([{ match: { promptIncludes: 'CLAUDE-PDF-S' }, turn: [{ text: 'DONE-CLAUDE-PDF-S' }] }]);
    h.clearInvocations();
    const since = client.messages.length;
    chat(id, 'CLAUDE-PDF-S read this', [file('report.pdf', REPORT)]);
    assert.ok(await storedFor(id, since), 'the PDF is stored');
    assert.ok(await resultFor(id, 'DONE-CLAUDE-PDF-S', since), 'the message is answered');
    const pick = () => h.readPrompts().filter((p) => p.line !== undefined && p.prompt.includes('CLAUDE-PDF-S'));
    assert.ok(await h.waitUntil(() => pick().length === 1, { timeout: 15000 }), 'one turn read');
    assert.deepStrictEqual(JSON.parse(pick()[0].line).message.content.slice(1),
      [{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: REPORT.toString('base64') } }]);
    h.reapConvo(id);
  });

  test('exactly 20 images over four turns are each stored', async () => {
    needsRecording();
    const id = h.freshConvoId('codex-twenty');
    const threadId = await twentyOver4Turns(id, 'TWENTY-S');
    const { instance, ...entry } = entryOf(id, threadId);
    assert.strictEqual(entry.images, 20, 'the thread was sent 20 images');
    assert.strictEqual(store.readRecord(h.workspaceDir, id).messages.length, 4, 'four entries');
    h.reapConvo(id);
  });

  test('a 21st image after 20 over four turns is refused codex-images', async () => {
    needsRecording();
    const id = h.freshConvoId('codex-21st');
    const threadId = await twentyOver4Turns(id, 'MORE-S');
    await refusedAsBefore({ conversationId: id, agent: 'researcher', sessionId: threadId, content: 'MORE-S-5 one more', attachments: shots(1, 33, 21) },
      { code: 'codex-images', title: 'Message not sent', text: IMAGES_TEXT });
    h.reapConvo(id);
  });

  test('three images of 3,500,000 bytes in one message are refused codex-images', async () => {
    const id = h.freshConvoId('codex-big');
    await refusedAsBefore({ conversationId: id, agent: 'researcher', content: 'BIG-S look', attachments: shots(3, 3500000) },
      { code: 'codex-images', title: 'Message not sent', text: IMAGES_TEXT });
    h.reapConvo(id);
  });

  test('images reaching exactly 10,000,000 bytes are stored', async () => {
    needsRecording();
    const id = h.freshConvoId('codex-ten-mb');
    codexAnswers(['TENMB-S']);
    const attachments = [...shots(2, 3500000), file('shot-3.png', png(10, 10, 3000000))];
    const { threadId } = await storedAndAnswered(id, 'TENMB-S', attachments);
    assert.strictEqual(entryOf(id, threadId).bytes, 10000000, 'the thread was sent 10,000,000 bytes');
    h.reapConvo(id);
  });

  test('a malformed entry for the thread refuses one image codex-images', async () => {
    needsRecording();
    const id = h.freshConvoId('codex-malformed');
    codexAnswers(['BAD-S']);
    const { threadId } = await storedAndAnswered(id, 'BAD-S', [file('diagram.png', DIAGRAM)]);
    const recordFile = path.join(folderOf(id), 'record.json');
    const record = JSON.parse(fs.readFileSync(recordFile, 'utf8'));
    record.sent[threadId] = { ...record.sent[threadId], files: 'not a list' };
    fs.writeFileSync(recordFile, JSON.stringify(record));
    await refusedAsBefore({ conversationId: id, agent: 'researcher', sessionId: threadId, content: 'BAD-S-2 and this', attachments: [file('chart.png', png(800, 600, 50))] },
      { code: 'codex-images', title: 'Message not sent', text: IMAGES_TEXT });
    h.reapConvo(id);
  });
});
