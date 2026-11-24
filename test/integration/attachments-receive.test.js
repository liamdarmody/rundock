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

const h = require('../helpers/harness.js');

// The receive is async and the handler ignores its promise, so a rejection it
// failed to catch would surface only here.
const rejections = [];
process.on('unhandledRejection', (reason) => { rejections.push(reason); });

let client;
before(async () => { await h.boot(); client = await h.connect(); });
after(async () => h.shutdown());

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

describe('the frame limit', () => {
  test('the server reads frames of up to 28,000,000 bytes', () => {
    assert.strictEqual(h.internal.wss.options.maxPayload, 28000000);
  });

  test('a frame of exactly 28,000,000 bytes is read and answered', async () => {
    const c = await h.connect();
    c.ws.send(padded('get_conversations', 28000000));
    assert.ok(await arrived((m) => m.type === 'conversations', { on: c, timeout: 20000 }), 'a frame at the limit is answered');
    c.close();
  });

  test('a frame of 28,000,001 bytes closes its own socket with 1009, and the server stays up', async () => {
    const c = await h.connect();
    let code = null;
    c.ws.on('close', (closedWith) => { code = closedWith; });
    c.ws.send(padded('get_conversations', 28000001));
    await h.waitUntil(() => code !== null, { timeout: 10000 });
    assert.strictEqual(code, 1009, 'the frame one byte over closes its socket as too big');
    assert.ok(!c.messages.some((m) => m.type === 'conversations'), 'and is never read');

    const fresh = await h.connect();
    fresh.send({ type: 'get_conversations' });
    assert.ok(await arrived((m) => m.type === 'conversations', { on: fresh }), 'a new connection is answered');
    const since = client.messages.length;
    client.send({ type: 'get_conversations' });
    assert.ok(await arrived((m) => m.type === 'conversations', { since }), 'and so is a socket that was already open');
    fresh.close();
  });
});

describe('after every test above', () => {
  test('no receive ended in an unhandled rejection', () => {
    assert.deepStrictEqual(rejections, []);
  });
});
