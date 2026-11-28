'use strict';
// Integration: a stored file as the file route serves it and as the history
// reports it.
//
// A request for a file under `.rundock/attachments/` is served only when the
// conversation's record still describes the file at that name, with the bytes
// the record check read; anything else there is answered 404. A request
// anywhere else is answered as before.
const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const h = require('../helpers/harness.js');
const auth = require('../../lib/auth/index.js');
const { getWorkspace } = require('../../lib/config.js');
const store = require('../../lib/attachments/store.js');
const receive = require('../../lib/attachments/receive.js');

const LINKS = { skip: process.platform === 'win32' && 'links need privileges on Windows' };
const ID = '1764000000000';

function png(width, height, size) {
  const b = Buffer.alloc(size);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'latin1');
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
}
const PNG = png(2576, 1610, 64);
const OTHER_PNG = png(2576, 1610, 64).fill(0x41, 40);
const PDF = Buffer.from('%PDF-1.7\na report\n%%EOF\n', 'latin1');
const CSV = Buffer.from('a,b\n1,2\n');

const folderOf = (id) => path.join(h.workspaceDir, '.rundock', 'attachments', id);
const storedPath = (...parts) => ['.rundock', 'attachments', ...parts].join('/');
const fileUrl = (rel) => '/workspace-file?path=' + encodeURIComponent(rel);
const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

// A GET with the body kept as bytes.
function get(urlPath, headers = h.authHeaders()) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: h.port, method: 'GET', path: urlPath, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks), headers: res.headers }));
    });
    req.on('error', reject);
    req.end();
  });
}
function post(urlPath, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: h.port, method: 'POST', path: urlPath, headers }, (res) => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers }));
    });
    req.on('error', reject);
    req.end();
  });
}

// The conversation's three files as the store keeps them, written afresh,
// answering the record's entry for them.
async function stored() {
  fs.rmSync(folderOf(ID), { recursive: true, force: true });
  fs.rmSync(path.join(h.workspaceDir, 'copy'), { recursive: true, force: true });
  return store.writeMessageFiles(h.workspaceDir, ID, [
    { name: 'diagram.png', bytes: PNG },
    { name: 'report.pdf', bytes: PDF },
    { name: 'notes.csv', bytes: CSV },
  ]);
}
const refused = (res) => {
  assert.strictEqual(res.status, 404);
  assert.strictEqual(res.body.toString(), 'File not found');
};

let mediaCookie;
before(async () => {
  await h.boot();
  fs.writeFileSync(path.join(h.workspaceDir, 'chart.png'), PNG);
  const code = (/#c=([A-Za-z0-9_-]+)/.exec(auth.signInLink(h.port)) || [])[1];
  const res = await post('/api/auth/session', { 'X-Rundock-Code': code });
  mediaCookie = [].concat(res.headers['set-cookie'] || []).map((c) => c.split(';')[0]).find((c) => c.startsWith('rundock_media_'));
});
after(async () => h.shutdown());

describe('the file route serves a stored file only as its record describes it', () => {
  beforeEach(stored);

  test('a stored PNG is served with its bytes and the four headers given the key', async () => {
    const res = await get(fileUrl(storedPath(ID, '1-diagram.png')));
    assert.strictEqual(res.status, 200);
    assert.ok(res.body.equals(PNG));
    assert.strictEqual(res.headers['content-type'], 'image/png');
    assert.strictEqual(res.headers['x-content-type-options'], 'nosniff');
    assert.strictEqual(res.headers['content-disposition'], 'inline');
    assert.strictEqual(res.headers['cache-control'], 'no-cache, no-store, must-revalidate');
  });

  test('a stored PNG is served with its bytes given the media cookie', async () => {
    assert.ok(mediaCookie, 'the sign-in exchange sets a media cookie');
    const res = await get(fileUrl(storedPath(ID, '1-diagram.png')), { Cookie: mediaCookie });
    assert.strictEqual(res.status, 200);
    assert.ok(res.body.equals(PNG));
    assert.strictEqual(res.headers['content-type'], 'image/png');
  });

  test('a stored PDF is served as application/pdf', async () => {
    const res = await get(fileUrl(storedPath(ID, '2-report.pdf')));
    assert.strictEqual(res.status, 200);
    assert.ok(res.body.equals(PDF));
    assert.strictEqual(res.headers['content-type'], 'application/pdf');
  });

  test('a stored PNG deleted since it was sent is refused', async () => {
    fs.rmSync(path.join(folderOf(ID), '1-diagram.png'));
    refused(await get(fileUrl(storedPath(ID, '1-diagram.png'))));
  });

  test('a stored PNG grown by one byte is refused', async () => {
    fs.appendFileSync(path.join(folderOf(ID), '1-diagram.png'), Buffer.from([0]));
    refused(await get(fileUrl(storedPath(ID, '1-diagram.png'))));
  });

  test('a stored PNG rewritten at the same size with other bytes is refused', async () => {
    fs.writeFileSync(path.join(folderOf(ID), '1-diagram.png'), OTHER_PNG);
    refused(await get(fileUrl(storedPath(ID, '1-diagram.png'))));
  });

  test('a link at the stored name to a PNG elsewhere in the workspace is refused', LINKS, async () => {
    const target = path.join(folderOf(ID), '1-diagram.png');
    fs.rmSync(target);
    fs.symlinkSync(path.join(h.workspaceDir, 'chart.png'), target);
    refused(await get(fileUrl(storedPath(ID, '1-diagram.png'))));
  });

  test("the conversation's folder replaced by a link to a copy is refused", LINKS, async () => {
    const copy = path.join(h.workspaceDir, 'copy');
    fs.cpSync(folderOf(ID), copy, { recursive: true });
    fs.rmSync(folderOf(ID), { recursive: true });
    fs.symlinkSync(copy, folderOf(ID), 'dir');
    try {
      refused(await get(fileUrl(storedPath(ID, '1-diagram.png'))));
    } finally {
      fs.unlinkSync(folderOf(ID));
    }
  });

  test("a PNG put in the folder that the record doesn't list is refused", async () => {
    fs.writeFileSync(path.join(folderOf(ID), '4-extra.png'), PNG);
    refused(await get(fileUrl(storedPath(ID, '4-extra.png'))));
  });

  test('a stored PNG the record gives as a pdf is refused', async () => {
    const record = store.readRecord(h.workspaceDir, ID);
    record.messages[0].files[0].type = 'pdf';
    fs.writeFileSync(path.join(folderOf(ID), 'record.json'), JSON.stringify(record));
    refused(await get(fileUrl(storedPath(ID, '1-diagram.png'))));
  });

  test('a fifth segment under the folder is refused, with a PNG there', async () => {
    fs.mkdirSync(path.join(folderOf(ID), 'sub'));
    fs.writeFileSync(path.join(folderOf(ID), 'sub', '1-diagram.png'), PNG);
    refused(await get(fileUrl(storedPath(ID, 'sub', '1-diagram.png'))));
  });

  test('an id off the pattern is refused, with a PNG at the stored name and a record listing it', async () => {
    const folder = folderOf('a.b');
    fs.mkdirSync(folder, { recursive: true });
    try {
      fs.writeFileSync(path.join(folder, '1-diagram.png'), PNG);
      const described = { file: '1-diagram.png', name: 'diagram.png', type: 'png', bytes: PNG.length, sha256: sha256(PNG), width: 2576, height: 1610 };
      fs.writeFileSync(path.join(folder, 'record.json'), JSON.stringify({ messages: [{ id: 'm', files: [described] }], sent: {} }));
      refused(await get(fileUrl(storedPath('a.b', '1-diagram.png'))));
    } finally {
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });

  // The other bytes are written at both spellings. On a disk that ignores
  // case they are one file; on one that tells case apart, the second is a
  // file of its own, which a compare that tells case apart would serve by
  // path. Either way the route must refuse it.
  test('the folder spelled in other case is refused for a rewritten file', async () => {
    const variant = path.join(h.workspaceDir, '.RUNDOCK', 'Attachments', ID);
    fs.writeFileSync(path.join(folderOf(ID), '1-diagram.png'), OTHER_PNG);
    fs.mkdirSync(variant, { recursive: true });
    fs.writeFileSync(path.join(variant, '1-diagram.png'), OTHER_PNG);
    refused(await get(fileUrl(`.RUNDOCK/Attachments/${ID}/1-diagram.png`)));
  });

  test('a stored CSV is refused, as before', async () => {
    refused(await get(fileUrl(storedPath(ID, '3-notes.csv'))));
  });

  test('a PNG outside the folder is served, as before', async () => {
    const res = await get(fileUrl('chart.png'));
    assert.strictEqual(res.status, 200);
    assert.ok(res.body.equals(PNG));
    assert.strictEqual(res.headers['content-type'], 'image/png');
  });

  test("the bytes served are the ones the record check read, never read again by path", async () => {
    const real = store.readRecordedFile;
    const checked = Buffer.from('bytes the record check read');
    const calls = [];
    store.readRecordedFile = (...args) => { calls.push(args); return { ...real(...args), state: 'present', bytes: checked }; };
    try {
      const res = await get(fileUrl(storedPath(ID, '1-diagram.png')));
      assert.strictEqual(res.status, 200);
      assert.ok(res.body.equals(checked), 'the body is what the record check answered');
      assert.deepStrictEqual(calls, [[getWorkspace(), ID, '1-diagram.png', { keep: true }]],
        'one record check, of this file, asked to keep the bytes it reads');
    } finally {
      store.readRecordedFile = real;
    }
  });

  // A throw that left the route would send no answer, and the request would
  // wait for good. The process hears of such a throw as an uncaught
  // exception, so hearing this one ends the request, and the test fails on
  // what it asserts rather than by waiting out a limit.
  test('a stored-file request whose record check throws is refused, and the server answers the next one', async () => {
    const real = store.readRecordedFile;
    const thrown = new Error('the record could not be read');
    let asked = 0;
    let escaped = false;
    let request;
    const heard = (e) => { if (e !== thrown) return; escaped = true; request.destroy(); };
    process.on('uncaughtException', heard);
    store.readRecordedFile = () => { asked++; throw thrown; };
    let res;
    try {
      res = await new Promise((resolve) => {
        request = http.request({ host: '127.0.0.1', port: h.port, method: 'GET', path: fileUrl(storedPath(ID, '1-diagram.png')), headers: h.authHeaders() }, (r) => {
          const chunks = [];
          r.on('data', (c) => chunks.push(c));
          r.on('end', () => resolve({ status: r.statusCode, body: Buffer.concat(chunks), headers: r.headers }));
        });
        request.on('error', () => resolve(null));
        request.end();
      });
    } finally {
      store.readRecordedFile = real;
      process.removeListener('uncaughtException', heard);
    }
    assert.strictEqual(escaped, false, "the record check's throw stayed inside the route, which answered");
    assert.strictEqual(asked, 1, 'the record check was asked once, and threw');
    refused(res);
    const next = await get(fileUrl(storedPath(ID, '1-diagram.png')));
    assert.strictEqual(next.status, 200, 'the server still answers a request for a file that is there');
    assert.ok(next.body.equals(PNG));
  });
});

describe('the history reply says which of its named files are there', () => {
  const OTHER = '1764000000001';
  const DIAGRAM = { name: 'diagram.png', type: 'png', bytes: PNG.length, width: 2576, height: 1610 };
  let client;
  let sessionsDir;
  let sessions = 0;
  let entry;

  // A session file of its own holding these lines, as Claude Code writes them.
  function session(lines) {
    const sessionId = `sess-files-${++sessions}`;
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(path.join(sessionsDir, `${sessionId}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    return sessionId;
  }
  const said = (content) => ({ type: 'user', message: { role: 'user', content }, timestamp: null });
  const answered = (text) => ({ message: { role: 'assistant', content: [{ type: 'text', text }] }, timestamp: null });
  // A message as the server stores it: its words, then one line per file.
  const sent = (content, ...files) => receive.storedText(content, ID, { files });

  function history(msg) {
    const since = client.messages.length;
    client.send({ type: 'get_session_history', ...msg });
    return client.waitFor(
      (m) => m.type === 'session_history' && m.conversationId === msg.conversationId,
      { since, label: `session_history for ${msg.conversationId}` },
    ).then((r) => r.msg);
  }
  // Every read of a record the history makes while `run` runs.
  async function counted(run) {
    const real = store.readRecordedFile;
    const reads = [];
    store.readRecordedFile = (...args) => { reads.push(args.slice(1)); return real(...args); };
    try {
      return { res: await run(), reads };
    } finally {
      store.readRecordedFile = real;
    }
  }
  // The handler's session reader replaced while `run` runs.
  async function withReader(reader, run) {
    const ctx = h.internal.wsHandlerContext.store;
    const real = ctx.parseSessionHistory;
    ctx.parseSessionHistory = reader;
    try {
      return await run();
    } finally {
      ctx.parseSessionHistory = real;
    }
  }

  before(async () => {
    client = await h.connect();
    sessionsDir = path.join(process.env.HOME, '.claude', 'projects', h.workspaceDir.replace(/\//g, '-'));
  });
  beforeEach(async () => { entry = await stored(); });

  test('a user message naming a present PNG gives its entry with width and height', async () => {
    const sessionId = session([said(sent('Here is the diagram', entry.files[0]))]);
    const res = await history({ conversationId: ID, sessionId });
    assert.deepStrictEqual(res.files, { '1-diagram.png': { ...DIAGRAM, state: 'present' } });
  });

  test('a user message naming a file rewritten since it was sent gives it as changed', async () => {
    fs.writeFileSync(path.join(folderOf(ID), '1-diagram.png'), OTHER_PNG);
    const sessionId = session([said(sent('Here is the diagram', entry.files[0]))]);
    const res = await history({ conversationId: ID, sessionId });
    assert.deepStrictEqual(res.files, { '1-diagram.png': { ...DIAGRAM, state: 'changed' } });
  });

  test('a user message naming a deleted file gives it as missing', async () => {
    fs.rmSync(path.join(folderOf(ID), '1-diagram.png'));
    const sessionId = session([said(sent('Here is the diagram', entry.files[0]))]);
    const res = await history({ conversationId: ID, sessionId });
    assert.deepStrictEqual(res.files, { '1-diagram.png': { ...DIAGRAM, state: 'missing' } });
  });

  test('the history read again after the file is deleted gives it as missing, where the first read gave it present', async () => {
    const sessionId = session([said(sent('Here is the diagram', entry.files[0]))]);
    const first = await history({ conversationId: ID, sessionId });
    assert.deepStrictEqual(first.files, { '1-diagram.png': { ...DIAGRAM, state: 'present' } });
    fs.rmSync(path.join(folderOf(ID), '1-diagram.png'));
    const again = await history({ conversationId: ID, sessionId });
    assert.deepStrictEqual(again.files, { '1-diagram.png': { ...DIAGRAM, state: 'missing' } });
  });

  test("a name the record doesn't list gives only its state, missing", async () => {
    fs.writeFileSync(path.join(folderOf(ID), '4-extra.png'), PNG);
    const unlisted = { file: '4-extra.png', type: 'png', bytes: PNG.length };
    const sessionId = session([said(sent('And another', unlisted))]);
    const res = await history({ conversationId: ID, sessionId });
    assert.deepStrictEqual(res.files, { '4-extra.png': { state: 'missing' } });
  });

  test('a file the record gives a type other than its name gives is missing', async () => {
    const record = store.readRecord(h.workspaceDir, ID);
    record.messages[0].files[0].type = 'pdf';
    fs.writeFileSync(path.join(folderOf(ID), 'record.json'), JSON.stringify(record));
    const sessionId = session([said(sent('Here is the diagram', entry.files[0]))]);
    const res = await history({ conversationId: ID, sessionId });
    assert.deepStrictEqual(res.files, { '1-diagram.png': { ...DIAGRAM, type: 'pdf', state: 'missing' } });
  });

  test("a line naming another conversation's present file gives no key", async () => {
    const theirs = await store.writeMessageFiles(h.workspaceDir, OTHER, [{ name: 'diagram.png', bytes: PNG }]);
    try {
      const line = receive.storedText('Look at theirs', OTHER, theirs);
      const sessionId = session([said(line)]);
      const res = await history({ conversationId: ID, sessionId });
      assert.deepStrictEqual(res.files, {});
    } finally {
      fs.rmSync(folderOf(OTHER), { recursive: true, force: true });
    }
  });

  test('a file of the record that no message names gives no key', async () => {
    const sessionId = session([said(sent('Only the diagram', entry.files[0]))]);
    const res = await history({ conversationId: ID, sessionId });
    assert.ok(res.files && typeof res.files === 'object', 'the reply carries files');
    assert.deepStrictEqual(Object.keys(res.files), ['1-diagram.png']);
  });

  test('a line in an assistant message gives no key', async () => {
    const sessionId = session([said('What did I send?'), answered(sent('You sent this', entry.files[0]))]);
    const res = await history({ conversationId: ID, sessionId });
    assert.deepStrictEqual(res.files, {});
  });

  test('the not-available form a turn writes in place of a line gives no key', async () => {
    const sessionId = session([said('Here it is\n[Attached file not available: 1-diagram.png]')]);
    const res = await history({ conversationId: ID, sessionId });
    assert.deepStrictEqual(res.files, {});
  });

  test('the changed form a turn writes in place of a line gives no key', async () => {
    const sessionId = session([said("Here it is\n[Attached file changed since it was attached, so it isn't shown: 1-diagram.png]")]);
    const res = await history({ conversationId: ID, sessionId });
    assert.deepStrictEqual(res.files, {});
  });

  // JavaScript reads each of these as a line terminator, but a line ends only
  // at a line break, so a line with one after it is not the whole line. The
  // row is handed to the history by its session reader, which a session file
  // can't do for the two separators: the reader splits its lines at them. The
  // two are built from their code points, so this file stays ASCII.
  test('a line followed by a carriage return, a line separator or a paragraph separator gives no key', async () => {
    const after = {
      'a carriage return': String.fromCharCode(0x0d),
      'a line separator': String.fromCharCode(0x2028),
      'a paragraph separator': String.fromCharCode(0x2029),
    };
    for (const [label, character] of Object.entries(after)) {
      const text = sent('Here is the diagram', entry.files[0]) + character;
      const row = { role: 'user', content: text, timestamp: null };
      const res = await withReader(async () => ({ messages: [row], totalCount: 1, hasMore: false }),
        () => history({ conversationId: ID, sessionId: 'sess-files-reader' }));
      assert.deepStrictEqual(res.messages, [row], `the row holds the line and ${label} as written`);
      assert.deepStrictEqual(res.files, {}, `a line followed by ${label} names no file`);
    }
  });

  test('a file named in two messages is one key, read once', async () => {
    const sessionId = session([said(sent('First', entry.files[0])), answered('Seen'), said(sent('Again', entry.files[0], entry.files[0]))]);
    const { res, reads } = await counted(() => history({ conversationId: ID, sessionId }));
    assert.deepStrictEqual(res.files, { '1-diagram.png': { ...DIAGRAM, state: 'present' } });
    assert.deepStrictEqual(reads, [[ID, '1-diagram.png']], 'one read, with no keep');
  });

  test('a merged reply gives no key for a file named only outside the page it returns', async () => {
    const sessionId = session([said(sent('First', entry.files[0])), answered('Seen'), said('Second'), answered('Noted')]);
    const page = await history({ conversationId: ID, sessionIds: [{ sessionId }], limit: 2 });
    assert.deepStrictEqual(page.messages.map((m) => m.content), ['Second', 'Noted']);
    assert.deepStrictEqual(page.files, {});
    const earlier = await history({ conversationId: ID, sessionIds: [{ sessionId }], limit: 2, offset: 2 });
    assert.deepStrictEqual(Object.keys(earlier.files || {}), ['1-diagram.png'], 'the page that holds the line names it');
  });

  test('the merged error reply carries no files and reads no record', async () => {
    const sessionId = session([said(sent('Here is the diagram', entry.files[0]))]);
    // A session whose lines can't be read as a list fails the merge.
    const { res, reads } = await counted(() => withReader(async () => ({ messages: null }),
      () => history({ conversationId: ID, sessionIds: [{ sessionId }] })));
    assert.deepStrictEqual(res, { type: 'session_history', conversationId: ID, messages: [], totalCount: 0, hasMore: false, files: {} });
    assert.deepStrictEqual(reads, []);
  });

  test('the single-session error reply carries no files and reads no record', async () => {
    const sessionId = session([said(sent('Here is the diagram', entry.files[0]))]);
    const { res, reads } = await counted(() => withReader(async () => { throw new Error('unreadable'); },
      () => history({ conversationId: ID, sessionId })));
    assert.deepStrictEqual(res, { type: 'session_history', conversationId: ID, messages: [], totalCount: 0, hasMore: false, files: {} });
    assert.deepStrictEqual(reads, []);
  });

  test('a reply with no conversation id carries no files and reads no record', async () => {
    const sessionId = session([said(sent('Here is the diagram', entry.files[0]))]);
    const { res, reads } = await counted(() => history({ sessionId }));
    assert.strictEqual(res.messages.length, 1);
    assert.deepStrictEqual(res.files, {});
    assert.deepStrictEqual(reads, []);
  });

  test('a reply whose conversation id is off the pattern carries no files and reads no record', async () => {
    const sessionId = session([said(sent('Here is the diagram', entry.files[0]))]);
    const { res, reads } = await counted(() => history({ conversationId: 'a.b', sessionId }));
    assert.strictEqual(res.messages.length, 1);
    assert.deepStrictEqual(res.files, {});
    assert.deepStrictEqual(reads, []);
  });

  test('the single-session reply keeps its messages, counts and paging, with files added', async () => {
    const third = sent('Third', entry.files[0]);
    const sessionId = session([said('First'), answered('Second'), said(third)]);
    const res = await history({ conversationId: ID, sessionId, limit: 2 });
    assert.deepStrictEqual(res, {
      type: 'session_history',
      conversationId: ID,
      messages: [
        { role: 'assistant', content: 'Second', timestamp: null },
        { role: 'user', content: third, timestamp: null },
      ],
      totalCount: 3,
      hasMore: true,
      files: { '1-diagram.png': { ...DIAGRAM, state: 'present' } },
    });
  });

  test('the merged reply keeps its messages, counts and paging, with files added', async () => {
    const third = sent('Third', entry.files[0]);
    const sessionId = session([said('First'), answered('Second'), said(third)]);
    const res = await history({ conversationId: ID, sessionIds: [{ sessionId }], limit: 2 });
    assert.deepStrictEqual(res, {
      type: 'session_history',
      conversationId: ID,
      messages: [
        { role: 'assistant', content: 'Second', agentId: null, timestamp: null },
        { role: 'user', content: third, agentId: null, timestamp: null },
      ],
      totalCount: 3,
      hasMore: true,
      files: { '1-diagram.png': { ...DIAGRAM, state: 'present' } },
    });
  });
});
