'use strict';
// Integration: what a Codex agent is sent for a turn that names attached
// files, at the two places the server starts one, and what each send records.
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

function scenario(rules) {
  fs.writeFileSync(path.join(h.workspaceDir, 'stub-scenario.json'), JSON.stringify({ rules, deadSessions: [] }));
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
