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
const store = require('../../lib/attachments/store.js');

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

// The conversation's three files as the store keeps them, written afresh.
async function stored() {
  fs.rmSync(folderOf(ID), { recursive: true, force: true });
  fs.rmSync(path.join(h.workspaceDir, 'copy'), { recursive: true, force: true });
  await store.writeMessageFiles(h.workspaceDir, ID, [
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
    store.readRecordedFile = (...args) => ({ ...real(...args), state: 'present', bytes: checked });
    try {
      const res = await get(fileUrl(storedPath(ID, '1-diagram.png')));
      assert.strictEqual(res.status, 200);
      assert.ok(res.body.equals(checked), 'the body is what the record check answered');
    } finally {
      store.readRecordedFile = real;
    }
  });
});
