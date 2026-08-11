'use strict';
// Characterisation: the chat process-close paths, pinned as they behave today,
// before the WS handlers move out of server.js.
//
// Three behaviours live only in the close handler and had no coverage:
//   1. A failed --resume (non-zero exit, stderr naming the session) retries
//      fresh exactly once, invisibly to the user beyond one info line.
//   2. A final stdout fragment still sitting in the line buffer when the
//      process dies is flushed: parseable JSON as itself, anything else as a
//      raw message.
//   3. A client connecting mid-turn is told about the live process so it can
//      restore the thinking indicator.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');

const h = require('../helpers/harness.js');

let client;

before(async () => {
  await h.boot();
  client = await h.connect();
});
after(async () => h.shutdown());

describe('resume failure recovery', () => {
  test('an expired session retries fresh once: info line, new spawn without --resume, normal answer', async () => {
    const convoId = h.freshConvoId('resume');
    h.clearInvocations();
    h.writeScenario([
      // The resumed spawn dies the way the real CLI does when a session is
      // gone. No agent gate: resume spawns carry no --agent flag.
      { match: { promptIncludes: 'retry me please', resume: true },
        crash: 1, stderr: 'No conversation found with session ID: sess-expired-1' },
      // The fresh retry (no --resume) answers normally.
      { match: { agent: 'chief-of-staff', promptIncludes: 'retry me please' },
        turn: [{ text: 'Fresh start answer' }] },
    ]);

    client.send({ type: 'chat', conversationId: convoId, agent: 'chief-of-staff', content: 'retry me please', sessionId: 'sess-expired-1' });

    const info = (await client.waitFor(
      m => m.type === 'system' && m.subtype === 'info' && m._conversationId === convoId,
      { label: 'session-expired info' })).msg;
    assert.strictEqual(info.content, 'Previous session expired. Starting fresh.');

    const result = (await client.waitFor(
      m => m.type === 'result' && m._conversationId === convoId,
      { label: 'fresh result' })).msg;
    assert.match(result.result, /Fresh start answer/);

    // Exactly two spawns: the failed resume, then the fresh retry.
    const spawns = h.readInvocations().filter(i => i.resume !== undefined);
    assert.strictEqual(spawns.length, 2);
    assert.strictEqual(spawns[0].resume, 'sess-expired-1');
    assert.strictEqual(spawns[1].resume, null, 'retry drops the dead session');

    h.reapConvo(convoId);
  });
});

describe('line-buffer flush at process exit', () => {
  test('a parseable JSON tail is delivered as itself, stamped with the conversation', async () => {
    const convoId = h.freshConvoId('tailjson');
    h.writeScenario([
      { match: { agent: 'chief-of-staff', promptIncludes: 'tail json' },
        crash: 0, crashTail: '{"type":"system","subtype":"stub_tail"}' },
    ]);

    client.send({ type: 'chat', conversationId: convoId, agent: 'chief-of-staff', content: 'tail json' });

    const tail = (await client.waitFor(
      m => m.type === 'system' && m.subtype === 'stub_tail',
      { label: 'flushed JSON tail' })).msg;
    assert.strictEqual(tail._conversationId, convoId);
    assert.strictEqual(tail._agent, 'chief-of-staff');

    // No result envelope ever arrived, so the close handler still unblocks
    // the client with done.
    const done = (await client.waitForEvent('system', 'done', convoId, { label: 'done after tail' })).msg;
    assert.strictEqual(done.code, 0);
    assert.ok(!h.internal.chatProcesses.has(convoId), 'entry cleaned up');
  });

  test('an unparseable tail is delivered as a raw message rather than dropped', async () => {
    const convoId = h.freshConvoId('tailraw');
    h.writeScenario([
      { match: { agent: 'chief-of-staff', promptIncludes: 'tail raw' },
        crash: 0, crashTail: 'partial-line-without-newline' },
    ]);

    client.send({ type: 'chat', conversationId: convoId, agent: 'chief-of-staff', content: 'tail raw' });

    const raw = (await client.waitFor(
      m => m.type === 'raw' && m._conversationId === convoId,
      { label: 'flushed raw tail' })).msg;
    assert.strictEqual(raw.content, 'partial-line-without-newline');

    await client.waitForEvent('system', 'done', convoId, { label: 'done after raw tail' });
  });
});

describe('connect during a live turn', () => {
  test('a fresh client is told about active processes so it can restore the thinking indicator', async () => {
    const convoId = h.freshConvoId('midturn');
    h.writeScenario([
      { match: { agent: 'chief-of-staff', promptIncludes: 'think slowly' },
        delayMs: 1500, turn: [{ text: 'Done thinking' }] },
    ]);

    client.send({ type: 'chat', conversationId: convoId, agent: 'chief-of-staff', content: 'think slowly' });
    await client.waitForEvent('system', 'process_started', convoId, { label: 'turn started' });

    const latecomer = await h.connect();
    const announce = (await latecomer.waitFor(m => m.type === 'active_processes', { label: 'active_processes' })).msg;
    const entry = announce.processes.find(p => p.conversationId === convoId);
    assert.ok(entry, 'live turn announced to the new client');
    assert.strictEqual(typeof entry.processId, 'string');
    assert.strictEqual(entry.agentId, 'chief-of-staff');
    assert.strictEqual(entry.idle, false);
    assert.strictEqual(entry.responseText, '');
    assert.strictEqual(entry.delegation, null);

    await client.waitFor(m => m.type === 'result' && m._conversationId === convoId, { label: 'turn finished' });
    latecomer.close();
    h.reapConvo(convoId);
  });
});
