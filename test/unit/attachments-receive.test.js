'use strict';
// A chat message's attachments, from the page's payload to the record: the
// shape checked in a fixed order before anything is decoded or written, the
// files handed to the store whole, and the text the message carries from then
// on. Every refusal here leaves a fresh workspace with no attachments folder.

const { test, describe } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const { writeFileExclusive } = require('../../lib/workspace/link-safe-write.js');
const store = require('../../lib/attachments/store.js');
const config = require('../../lib/config.js');
const { makeTempDir } = require('../helpers/workspace.js');

// Loaded so that a missing module fails each test on its first assertion,
// never on the require.
const receive = (() => {
  try { return require('../../lib/attachments/receive.js'); } catch (e) {
    if (e && e.code === 'MODULE_NOT_FOUND' && /attachments[\\/]receive/.test(String(e.message))) return null;
    throw e;
  }
})();
const ready = (name) => assert.strictEqual(typeof (receive && receive[name]), 'function', `receive exports ${name}`);
const receiveAttachments = (...args) => receive.receiveAttachments(...args);

const workspace = () => fs.realpathSync(makeTempDir('receive-'));
const attachmentsOf = (ws) => path.join(ws, '.rundock', 'attachments');
const folderOf = (ws, id = 'alpha') => path.join(attachmentsOf(ws), id);
const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const b64 = (bytes) => bytes.toString('base64');

function pngBytes(width = 10, height = 10, size = 33) {
  const b = Buffer.alloc(size);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'latin1');
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
}
function jpegBytes(width = 10, height = 10) {
  const frame = Buffer.alloc(19);
  frame[0] = 0xff; frame[1] = 0xc0;
  frame.writeUInt16BE(17, 2);
  frame[4] = 8;
  frame.writeUInt16BE(height, 5);
  frame.writeUInt16BE(width, 7);
  frame[9] = 3;
  return Buffer.concat([Buffer.from([0xff, 0xd8]), frame, Buffer.from([0xff, 0xd9])]);
}
function gifBytes(width = 10, height = 10) {
  const b = Buffer.alloc(13);
  b.write('GIF89a', 0, 'latin1');
  b.writeUInt16LE(width, 6);
  b.writeUInt16LE(height, 8);
  return b;
}
function webpBytes(width = 10, height = 10) {
  const b = Buffer.alloc(40);
  b.write('RIFF', 0, 'latin1');
  b.writeUInt32LE(32, 4);
  b.write('WEBPVP8 ', 8, 'latin1');
  b.writeUInt32LE(20, 16);
  b[20] = 0x10; b[21] = 0x02; b[22] = 0x00;
  b[23] = 0x9d; b[24] = 0x01; b[25] = 0x2a;
  b.writeUInt16LE(width, 26);
  b.writeUInt16LE(height, 28);
  return b;
}
const pdfBytes = (size = 40) => {
  const b = Buffer.alloc(size, 0x20);
  b.write('%PDF-1.7\n', 0, 'latin1');
  return b;
};

const file = (name, bytes) => ({ name, data: b64(bytes) });
const SHOT = () => file('Screen Shot.png', pngBytes(640, 480));
const message = (over = {}) => ({ type: 'chat', conversationId: 'alpha', content: 'see these', attachments: [SHOT()], ...over });

// An assert.rejects check for a refusal: an Error with this code and fields.
function refused(code, fields = {}) {
  return (e) => {
    assert.ok(e instanceof Error, 'a refusal is an Error');
    assert.strictEqual(e.code, code);
    for (const [key, value] of Object.entries(fields)) assert.deepStrictEqual(e[key], value, key);
    return true;
  };
}

// Refused with `code`, and nothing under .rundock on a fresh workspace.
async function refusedBare(msg, code, fields) {
  ready('receiveAttachments');
  const ws = workspace();
  await assert.rejects(receiveAttachments(ws, msg), refused(code, fields));
  assert.strictEqual(fs.existsSync(attachmentsOf(ws)), false, 'no attachments folder');
}

describe('MAX_PAYLOAD', () => {
  test('is 28,000,000 bytes', () => {
    assert.strictEqual(receive && receive.MAX_PAYLOAD, 28000000);
  });
});

describe('createReceiver: how the chat handler hands a message over', () => {
  // A server socket as the receiver sees one: it answers through send, and a
  // stored message comes back into the handler through emit.
  function socket() {
    const sock = new EventEmitter();
    sock.readyState = 1;
    sock.sent = [];
    sock.back = [];
    sock.send = (m) => sock.sent.push(JSON.parse(m));
    sock.on('message', (data) => sock.back.push(JSON.parse(data)));
    return sock;
  }
  function inWorkspace(ws, run) {
    const was = config.getWorkspace();
    config.setWorkspace(ws);
    return Promise.resolve().then(run).finally(() => config.setWorkspace(was));
  }

  test('sets no limit on how many messages with files it takes in at once', async () => {
    ready('createReceiver');
    ready('whenReceived');
    assert.deepStrictEqual(Object.keys(receive).filter((k) => typeof receive[k] === 'number'), ['MAX_PAYLOAD'], 'no limit is exported');
    const ws = workspace();
    const sock = socket();
    await inWorkspace(ws, async () => {
      const receiver = receive.createReceiver({ clients: new Set([sock]), findAgent: () => null });
      const ids = Array.from({ length: 12 }, (_, n) => `conv-${n}`);
      for (const id of ids) assert.strictEqual(receiver.takes(message({ conversationId: id }), sock, true), true);
      await Promise.all(ids.map((id) => receive.whenReceived(id)));
      assert.deepStrictEqual(sock.sent.map((m) => [m.type, m.conversationId]), ids.map((id) => ['chat_stored', id]));
      assert.deepStrictEqual(sock.back.map((m) => m.conversationId), ids, 'each came back into the handler once');
      for (const back of sock.back) {
        assert.strictEqual('attachments' in back, false, 'no file data comes back');
        assert.strictEqual(receive.checkReference(ws, back), true, 'its reference names its own entry');
      }
    });
  });

  test('refuses files for a Codex agent before the payload is looked at', () => {
    ready('createReceiver');
    const sock = socket();
    const asked = [];
    const receiver = receive.createReceiver({ clients: new Set([sock]), findAgent: (slug) => { asked.push(slug); return { runtime: 'codex' }; } });
    const msg = { type: 'chat', conversationId: '../..', content: 5, agent: 'gamma', attachments: [{ name: 5 }] };
    assert.strictEqual(receiver.takes(msg, sock, true), true, 'the message is taken');
    assert.deepStrictEqual(asked, ['gamma']);
    assert.deepStrictEqual(sock.sent, [{ type: 'chat_refused', conversationId: '../..', code: 'codex-files', title: 'Message not sent',
      text: 'This agent runs on Codex, which can\'t open attached files yet. Remove the files to send your message.' }]);
    assert.deepStrictEqual(sock.back, [], 'nothing went back into the handler');
  });

  test('looks up the default agent when the message names none, and lets a Claude agent through', async () => {
    ready('createReceiver');
    const ws = workspace();
    const sock = socket();
    const asked = [];
    await inWorkspace(ws, async () => {
      const receiver = receive.createReceiver({ clients: new Set([sock]), findAgent: (slug) => { asked.push(slug); return { runtime: 'claude' }; } });
      receiver.takes(message(), sock, true);
      await receive.whenReceived('alpha');
    });
    assert.deepStrictEqual(asked, ['default']);
    assert.deepStrictEqual(sock.sent.map((m) => m.type), ['chat_stored']);
  });
});

describe('receiveAttachments refuses the payload in a fixed order, before anything is written', () => {
  test('an attachmentEntry beside attachments is bad-payload, ahead of every other fault', async () => {
    await refusedBare(message({ attachmentEntry: 'x' }), 'bad-payload');
    await refusedBare(message({ attachmentEntry: undefined }), 'bad-payload');
    await refusedBare(message({ attachmentEntry: 'x', conversationId: '../..', content: 5 }), 'bad-payload');
  });

  for (const value of [null, {}, 'x']) {
    test(`attachments of ${JSON.stringify(value)} is bad-payload, ahead of a bad ID`, async () => {
      await refusedBare(message({ attachments: value }), 'bad-payload');
      await refusedBare(message({ attachments: value, conversationId: '../..' }), 'bad-payload');
    });
  }

  for (const id of [undefined, '../..', '', 'a'.repeat(65), ['alpha']]) {
    test(`a conversation ID of ${JSON.stringify(id)} is bad-id, ahead of a bad content`, async () => {
      await refusedBare(message({ conversationId: id }), 'bad-id');
      await refusedBare(message({ conversationId: id, content: 5 }), 'bad-id');
    });
  }

  test('a missing conversation ID never falls back to default', async () => {
    ready('receiveAttachments');
    const ws = workspace();
    const msg = message();
    delete msg.conversationId;
    await assert.rejects(receiveAttachments(ws, msg), refused('bad-id'));
    assert.strictEqual(fs.existsSync(folderOf(ws, 'default')), false);
  });

  for (const content of [undefined, 5, null]) {
    test(`content of ${JSON.stringify(content)} is bad-payload, ahead of too many files`, async () => {
      await refusedBare(message({ content }), 'bad-payload');
      await refusedBare(message({ content, attachments: new Array(6).fill(null) }), 'bad-payload');
    });
  }

  test('six elements of null are too-many-files, ahead of the elements\' shape', async () => {
    await refusedBare(message({ attachments: new Array(6).fill(null) }), 'too-many-files', { count: 6, limit: 5 });
  });

  test('an array of 100,000 is too-many-files without one element read', async () => {
    let touched = 0;
    const list = new Proxy(new Array(100000).fill(null), {
      get(target, key) {
        if (typeof key === 'string' && /^\d+$/.test(key)) touched += 1;
        return Reflect.get(target, key);
      },
    });
    await refusedBare(message({ attachments: list }), 'too-many-files', { count: 100000, limit: 5 });
    assert.strictEqual(touched, 0, 'no element was read');
  });

  test('five files are accepted and six refused', async () => {
    ready('receiveAttachments');
    const five = [1, 2, 3, 4, 5].map((n) => file(`notes-${n}.txt`, Buffer.from(`line ${n}\n`)));
    const ws = workspace();
    const { entry } = await receiveAttachments(ws, message({ attachments: five }));
    assert.strictEqual(entry.files.length, 5);
    await refusedBare(message({ attachments: [...five, SHOT()] }), 'too-many-files', { count: 6, limit: 5 });
  });

  const SHAPES = [null, [], 'x', 5, { name: 5, data: '' }, { name: 'notes.txt' }, { data: 'YQ==' }, { name: 'notes.txt', data: ['YQ=='] }];
  for (const element of SHAPES) {
    test(`an element of ${JSON.stringify(element)} is bad-payload, even after a good one`, async () => {
      await refusedBare(message({ attachments: [element] }), 'bad-payload');
      await refusedBare(message({ attachments: [SHOT(), element] }), 'bad-payload');
    });
  }

  for (const data of ['YWJ', 'YWJj\n', 'YW-j', '!!!!']) {
    test(`data of ${JSON.stringify(data)} is not canonical base64 and is bad-payload`, async () => {
      await refusedBare(message({ attachments: [{ name: 'notes.txt', data }] }), 'bad-payload');
      await refusedBare(message({ attachments: [SHOT(), { name: 'notes.txt', data }] }), 'bad-payload');
    });
  }

  test('empty data is canonical base64 and reaches the store as no bytes', async () => {
    ready('receiveAttachments');
    const ws = workspace();
    const { entry } = await receiveAttachments(ws, message({ attachments: [{ name: 'notes.txt', data: '' }] }));
    assert.deepStrictEqual(entry.files.map((f) => [f.file, f.bytes]), [['1-notes.txt', 0]]);
  });
});

describe('the store\'s refusals pass through unchanged', () => {
  test('a limit refusal keeps its name and figures', async () => {
    await refusedBare(message({ attachments: [file('alpha.pdf', pdfBytes(10000001))] }), 'pdf-bytes', { name: 'alpha.pdf', bytes: 10000001, limit: 10000000 });
    await refusedBare(message({ attachments: [file('beta.zip', Buffer.from('PK\x03\x04'))] }), 'unsupported', { name: 'beta.zip' });
    const big = [file('alpha.pdf', pdfBytes(10000000)), file('beta.pdf', pdfBytes(10000000)), file('notes.txt', Buffer.from('a'))];
    await refusedBare(message({ attachments: big }), 'too-many-bytes', { bytes: 20000001, limit: 20000000 });
  });

  test('a deleted conversation is refused deleted, and a junk deleted list save-failed', async () => {
    ready('receiveAttachments');
    for (const [listed, code] of [[JSON.stringify(['alpha']), 'deleted'], ['not json', 'save-failed']]) {
      const ws = workspace();
      fs.mkdirSync(attachmentsOf(ws), { recursive: true });
      fs.writeFileSync(path.join(attachmentsOf(ws), 'deleted.json'), listed);
      await assert.rejects(receiveAttachments(ws, message()), refused(code));
      assert.deepStrictEqual(fs.readdirSync(attachmentsOf(ws)), ['deleted.json']);
    }
  });
});

describe('all or nothing, through the create seam', () => {
  const THREE = () => [SHOT(), file('Incident-Report-22-Nov.pdf', pdfBytes()), file('notes.txt', Buffer.from('first line\n'))];
  // A create that writes as the store does, except on call `n`, which throws.
  const failingOn = (n, error) => {
    let calls = 0;
    return (target, bytes) => {
      calls += 1;
      if (calls === n) throw error;
      return writeFileExclusive(target, bytes);
    };
  };
  const enospc = () => Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC', syscall: 'write' });

  test('ENOSPC on the second of three is disk-full naming it, the first file gone and no new entry', async () => {
    ready('receiveAttachments');
    const ws = workspace();
    const before = await receiveAttachments(ws, message({ attachments: [file('notes.txt', Buffer.from('earlier\n'))] }));
    const create = failingOn(2, enospc());
    await assert.rejects(receiveAttachments(ws, message({ attachments: THREE() }), { create }), refused('disk-full', { name: 'Incident-Report-22-Nov.pdf' }));
    assert.deepStrictEqual(fs.readdirSync(folderOf(ws)).sort(), ['1-notes.txt', 'record.json']);
    assert.deepStrictEqual(store.readRecord(ws, 'alpha').messages, [before.entry]);
  });

  test('the third file failing writes no record, and a plain Error is save-failed', async () => {
    ready('receiveAttachments');
    const ws = workspace();
    const create = failingOn(3, new Error('boom'));
    await assert.rejects(receiveAttachments(ws, message({ attachments: THREE() }), { create }), refused('save-failed'));
    assert.deepStrictEqual(fs.readdirSync(folderOf(ws)), []);
    assert.deepStrictEqual(store.readRecord(ws, 'alpha').messages, []);
  });
});

describe('the stored text', () => {
  test('is the typed text, then one line per file', async () => {
    ready('receiveAttachments');
    const ws = workspace();
    const msg = message({ attachments: [file('Screen Shot.png', pngBytes(640, 480, 1200000))] });
    const { content, entry } = await receiveAttachments(ws, msg);
    assert.strictEqual(content, 'see these\n[Attached: .rundock/attachments/alpha/1-Screen_Shot.png (PNG image, 1.2 MB)]');
    assert.deepStrictEqual(store.readRecord(ws, 'alpha').messages, [entry]);
  });

  test('names the stored file, never the name it was sent with', async () => {
    ready('receiveAttachments');
    const ws = workspace();
    const { content } = await receiveAttachments(ws, message({ conversationId: 'beta', attachments: [file('../../evil name.png', pngBytes())] }));
    assert.ok(content.includes('/1-_evil_name.png (PNG image, 1 KB)]'), content);
    assert.ok(!content.includes('../'), 'no ../');
    assert.ok(!content.includes('evil name'), 'no original name');
  });

  test('with no typed text, starts with the first line', async () => {
    ready('receiveAttachments');
    const ws = workspace();
    const { content } = await receiveAttachments(ws, message({ content: '', attachments: [SHOT(), file('notes.txt', Buffer.from('a\n'))] }));
    assert.strictEqual(content, '[Attached: .rundock/attachments/alpha/1-Screen_Shot.png (PNG image, 1 KB)]\n[Attached: .rundock/attachments/alpha/2-notes.txt (text file, 1 KB)]');
  });

  for (const [type, name, bytes, label] of [
    ['png', 'Screen Shot.png', pngBytes(), 'PNG image'],
    ['jpg', 'photo.jpeg', jpegBytes(), 'JPEG image'],
    ['gif', 'loop.gif', gifBytes(), 'GIF image'],
    ['webp', 'still.webp', webpBytes(), 'WebP image'],
    ['pdf', 'Incident-Report-22-Nov.pdf', pdfBytes(1000001), 'PDF document'],
    ['txt', 'notes.txt', Buffer.from('a\n'), 'text file'],
    ['md', 'notes.md', Buffer.from('# a\n'), 'Markdown file'],
    ['csv', 'table.csv', Buffer.from('a,b\n'), 'CSV file'],
  ]) {
    test(`labels a ${type} file "${label}"`, async () => {
      ready('receiveAttachments');
      const ws = workspace();
      const { content, entry } = await receiveAttachments(ws, message({ content: 'x', attachments: [file(name, bytes)] }));
      const stored = entry.files[0];
      assert.strictEqual(stored.type, type);
      const size = type === 'pdf' ? '1.1 MB' : '1 KB';
      assert.strictEqual(content, `x\n[Attached: .rundock/attachments/alpha/${stored.file} (${label}, ${size})]`);
    });
  }

  test('each line names a file of the entry whose bytes are what was sent', async () => {
    ready('receiveAttachments');
    const ws = workspace();
    const sent = [SHOT(), file('Incident-Report-22-Nov.pdf', pdfBytes()), file('notes.txt', Buffer.from('first\n'))];
    const { content, entry } = await receiveAttachments(ws, message({ attachments: sent }));
    const lines = content.split('\n').slice(1);
    assert.strictEqual(lines.length, sent.length);
    lines.forEach((line, i) => {
      const prefix = '[Attached: .rundock/attachments/alpha/';
      assert.ok(line.startsWith(prefix), line);
      const stored = line.slice(prefix.length, line.indexOf(' (', prefix.length));
      const described = entry.files.find((f) => f.file === stored);
      const bytes = fs.readFileSync(path.join(folderOf(ws), stored));
      assert.deepStrictEqual(bytes, Buffer.from(sent[i].data, 'base64'));
      assert.strictEqual(described.sha256, sha256(bytes));
      assert.strictEqual(store.checkRecordedFile(ws, 'alpha', stored), 'present');
    });
  });
});

describe('checkReference: a reference names an entry of the conversation\'s own record', () => {
  async function recorded() {
    const ws = workspace();
    const alpha = await receive.receiveAttachments(ws, message());
    const beta = await receive.receiveAttachments(ws, message({ conversationId: 'beta' }));
    return { ws, alpha: alpha.entry.id, beta: beta.entry.id };
  }
  const ref = (attachmentEntry, conversationId = 'alpha') => ({ type: 'chat', conversationId, content: 'x', attachmentEntry });

  test('accepts an entry of this conversation, and writes nothing', async () => {
    ready('checkReference');
    const { ws, alpha } = await recorded();
    const before = fs.readFileSync(path.join(folderOf(ws), 'record.json'));
    assert.strictEqual(receive.checkReference(ws, ref(alpha)), true);
    assert.deepStrictEqual(fs.readFileSync(path.join(folderOf(ws), 'record.json')), before);
  });

  test('refuses an unknown ID, a number, another conversation\'s entry and a missing conversation ID', async () => {
    ready('checkReference');
    const { ws, beta } = await recorded();
    assert.strictEqual(receive.checkReference(ws, ref('no-such-entry')), false);
    assert.strictEqual(receive.checkReference(ws, ref(7)), false);
    assert.strictEqual(receive.checkReference(ws, ref(beta)), false);
    assert.strictEqual(receive.checkReference(ws, ref(beta, undefined)), false);
  });

  test('refuses any reference when the record is unreadable', async () => {
    ready('checkReference');
    const { ws, alpha } = await recorded();
    fs.writeFileSync(path.join(folderOf(ws), 'record.json'), 'not json');
    assert.strictEqual(receive.checkReference(ws, ref(alpha)), false);
  });
});

describe('filesLeft: whether a refused delete left anything of the conversation\'s folder', () => {
  const noLinks = { skip: process.platform === 'win32' && 'links need privileges on Windows' };

  test('nothing is left when .rundock, attachments or the folder is missing, or sits under a file', () => {
    ready('filesLeft');
    const ws = workspace();
    assert.strictEqual(receive.filesLeft(ws, 'alpha'), false);
    fs.mkdirSync(path.join(ws, '.rundock'));
    assert.strictEqual(receive.filesLeft(ws, 'alpha'), false);
    fs.mkdirSync(attachmentsOf(ws));
    assert.strictEqual(receive.filesLeft(ws, 'alpha'), false);
    const flat = workspace();
    fs.writeFileSync(path.join(flat, '.rundock'), 'a file');
    assert.strictEqual(receive.filesLeft(flat, 'alpha'), false);
  });

  test('the folder itself is something left', () => {
    ready('filesLeft');
    const ws = workspace();
    fs.mkdirSync(folderOf(ws), { recursive: true });
    assert.strictEqual(receive.filesLeft(ws, 'alpha'), true);
  });

  test('a link on the way is something left, whatever it points at', noLinks, () => {
    ready('filesLeft');
    for (const at of ['.rundock', path.join('.rundock', 'attachments'), path.join('.rundock', 'attachments', 'alpha')]) {
      const ws = workspace();
      fs.mkdirSync(path.dirname(path.join(ws, at)), { recursive: true });
      fs.symlinkSync(path.join(ws, 'nowhere'), path.join(ws, at));
      assert.strictEqual(receive.filesLeft(ws, 'alpha'), true, `a link at ${at}`);
    }
  });

  test('a look that fails for another reason is something left',
    { skip: (process.platform === 'win32' || (process.getuid && process.getuid() === 0)) && 'permissions do not bind here' }, () => {
      ready('filesLeft');
      const ws = workspace();
      fs.mkdirSync(folderOf(ws), { recursive: true });
      fs.chmodSync(path.join(ws, '.rundock'), 0o000);
      try {
        assert.strictEqual(receive.filesLeft(ws, 'alpha'), true);
      } finally {
        fs.chmodSync(path.join(ws, '.rundock'), 0o755);
      }
    });
});
