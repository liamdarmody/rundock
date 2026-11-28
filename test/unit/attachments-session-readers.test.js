'use strict';
// A TURN SENT WITH IMAGES OR PDFS, READ BACK FROM THE SESSION FILE.
//
// Rundock sends a Claude Code agent a message with images or PDFs as an
// array: the text first, then a block for each file. Claude Code keeps the
// line in its session file as it was sent. Each reader of the session file
// takes that line as its text blocks joined, as it takes a message sent as
// text: the history shows it, the message count counts it, and both searches
// find its words. A block's data is never searched or shown. An array with no
// image or document block, and an array holding a tool result, are not the
// person's message, and stay out as before.
//
// The session files are written under a made-up home, where the readers look
// for them.
require('../helpers/made-up-home.js');
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { _internal: srv } = require('../../server.js');
const { probeSqlite, createSearchIndex } = require('../../search.js');
const { makeWorkspace, cleanup, standardTeam } = require('../helpers/workspace.js');

const probe = probeSqlite();

after(cleanup);
before(() => srv.setWorkspace(makeWorkspace({ agents: standardTeam() })));

const at = (s) => new Date(Date.parse('2026-07-01T10:00:00.000Z') + s * 1000).toISOString();
const userLine = (content, s) => ({ type: 'user', message: { role: 'user', content }, timestamp: at(s) });
const replyLine = (text, s) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] }, timestamp: at(s) });

const LINE = '[Attached: .rundock/attachments/1764000000000/1-screenshot.png (PNG image, 1 KB)]';
// The opening of a PNG's base64, letters and digits only, so it is one
// whole word to a search.
const DATA = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB';
const IMAGE = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: DATA } };
const PDF = { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: `JVBERi0x${DATA}` } };
const SAID = `Compare the pelican survey chart with last quarter's\n${LINE}`;
const ATTACHED = [{ type: 'text', text: SAID }, IMAGE, PDF];
const REPLY = 'The survey chart shows a rise in every region.';

// One session file under the made-up home's Claude Code folder.
let n = 0;
function session(lines) {
  const sessionId = `attached-turn-${++n}`;
  const dir = path.join(process.env.HOME, '.claude', 'projects', 'example-alpha');
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${sessionId}.jsonl`);
  fs.writeFileSync(filePath, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return { sessionId, filePath };
}

const history = async (s) => (await srv.parseSessionHistory(s.sessionId, Infinity)).messages;
const counted = (s) => srv.countSessionMessagesSync(s.sessionId);
const grepped = (query, s) => srv.grepSearchTranscripts(query, [{ id: 'example-convo', sessionId: s.sessionId }]);

// The search index's hits for `query`, from a fresh index of the one file.
function indexed(query, s) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'attached-turn-index-'));
  const idx = createSearchIndex({ dbPath: path.join(dir, 'search-index.db'), DatabaseSync: probe.DatabaseSync });
  try {
    idx.open();
    idx.reconcileConversations([{ conversationId: 'example-convo', sessions: [{ sessionId: s.sessionId, agentId: 'chief-of-staff', filePath: s.filePath }] }]);
    return idx.searchMessages(query, { collapse: false });
  } finally {
    try { idx.close(); } catch (e) { /* already closed */ }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
const noIndex = probe.available ? false : 'no node:sqlite on this runtime';

describe('each reader takes a turn sent with blocks as its text', () => {
  test('the history shows it as the person\'s message, its text blocks joined', async () => {
    const s = session([
      userLine(ATTACHED, 0),
      replyLine(REPLY, 1),
      userLine([{ type: 'text', text: 'First the chart' }, IMAGE, { type: 'text', text: 'then the table' }], 2),
    ]);
    assert.deepStrictEqual(await history(s), [
      { role: 'user', content: SAID, timestamp: at(0) },
      { role: 'assistant', content: REPLY, timestamp: at(1) },
      { role: 'user', content: 'First the chart\n\nthen the table', timestamp: at(2) },
    ]);
  });

  test('the message count counts it once, and never a prompt of Rundock\'s sent with a block', async () => {
    const s = session([
      userLine(ATTACHED, 0),
      replyLine(REPLY, 1),
      userLine([{ type: 'text', text: `[DELEGATION BRIEF]\nLook at the survey chart.\n${LINE}` }, IMAGE], 2),
      replyLine('Looked at it.', 3),
    ]);
    assert.strictEqual(counted(s), 3, 'the person\'s message and both replies; the brief is Rundock\'s own');
  });

  test('the transcript search finds a word of its text', async () => {
    const s = session([userLine(ATTACHED, 0), replyLine(REPLY, 1)]);
    const found = await grepped('pelican', s);
    assert.strictEqual(found.length, 1);
    assert.strictEqual(found[0].matchType, 'content');
    assert.match(found[0].snippet, /pelican survey chart/);
  });

  test('the search index finds a word of its text, as the person\'s', { skip: noIndex }, () => {
    const s = session([userLine(ATTACHED, 0), replyLine(REPLY, 1)]);
    const hits = indexed('pelican', s);
    assert.strictEqual(hits.length, 1);
    assert.strictEqual(hits[0].role, 'user');
    assert.strictEqual(hits[0].conversationId, 'example-convo');
  });
});

describe('what stays out', () => {
  // Passes on main by design: main reads no array at all. Its sibling, "the
  // history shows it as the person's message, its text blocks joined", fails
  // on main.
  test('an array of text alone is not the person\'s message, to any reader', async () => {
    const s = session([userLine([{ type: 'text', text: 'Only the pelican text' }], 0)]);
    assert.deepStrictEqual(await history(s), []);
    assert.strictEqual(counted(s), 0);
    assert.deepStrictEqual(await grepped('pelican', s), []);
    if (probe.available) assert.strictEqual(indexed('pelican', s).length, 0);
  });

  // Passes on main by design: main reads no array at all. Its sibling, "the
  // history shows it as the person's message, its text blocks joined", fails
  // on main.
  test('an array holding a tool result is not, even with text and an image beside it', async () => {
    const s = session([userLine([
      { type: 'tool_result', tool_use_id: 'example-tool', content: [{ type: 'text', text: 'pelican tool output' }, IMAGE] },
      { type: 'text', text: 'A pelican beside the result' },
      IMAGE,
    ], 0)]);
    assert.deepStrictEqual(await history(s), []);
    assert.strictEqual(counted(s), 0);
    assert.deepStrictEqual(await grepped('pelican', s), []);
    if (probe.available) assert.strictEqual(indexed('pelican', s).length, 0);
  });

  // Passes on main by design: main reads no array, so finds nothing in one.
  // Its sibling, "the transcript search finds a word of its text", fails on
  // main.
  test('no reader searches or shows a block\'s data', async () => {
    const s = session([userLine(ATTACHED, 0), replyLine(REPLY, 1)]);
    assert.ok(!JSON.stringify(await history(s)).includes(DATA), 'the history holds no block data');
    assert.deepStrictEqual(await grepped(DATA, s), []);
    if (probe.available) assert.strictEqual(indexed(DATA, s).length, 0);
  });
});
