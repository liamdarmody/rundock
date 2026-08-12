'use strict';
// Deterministic pins for the legacy spawn's close handler and the WS
// message-loop catch: the last root-remainder lines that had NO test driving
// them (the area held its floor only while the delegation glue's well-covered
// lines shared the denominator; slice 10 moved the glue out, so these paths
// must stand on their own coverage). Legacy mode (--print, one process per
// message) is env-gated per message, so flipping RUNDOCK_LEGACY_SPAWN inside
// this file's own server process is deterministic and leak-free: node --test
// runs each file in its own process, and after() clears the flag.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const h = require('../helpers/harness.js');

let client;

before(async () => {
  await h.boot();
  client = await h.connect();
  process.env.RUNDOCK_LEGACY_SPAWN = '1';
});
after(async () => {
  delete process.env.RUNDOCK_LEGACY_SPAWN;
  await h.shutdown();
});

test('legacy round-trip: one process per message, done on close, entry removed', async () => {
  const convoId = h.freshConvoId('legacy');
  h.writeScenario([
    { match: { promptIncludes: 'legacy ping' },  // legacy spawns pass no --agent
      turn: [{ text: 'LEGACY-PONG.' }] },
  ]);
  const since = client.messages.length;
  client.send({ type: 'chat', conversationId: convoId, agent: 'chief-of-staff', content: 'legacy ping' });
  await client.waitFor(m => m.type === 'system' && m.subtype === 'process_started' && m._conversationId === convoId, { since, label: 'legacy spawn' });
  await client.waitFor(m => m.type === 'system' && m.subtype === 'done' && m._conversationId === convoId, { since, label: 'done after --print exit' });
  // done is sent at result time; the map delete happens in the close handler
  // moments later. Wait for the close, not just the done.
  const deadline = Date.now() + 2000;
  while (h.internal.chatProcesses.has(convoId) && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 20));
  }
  assert.ok(!h.internal.chatProcesses.has(convoId), 'legacy entries do not outlive their process');
});

test('legacy resume failure: expired session falls back to a fresh spawn with a visible pill', async () => {
  const convoId = h.freshConvoId('legacyresume');
  h.writeScenario([
    // The --resume attempt dies the way the real CLI does: stderr complains
    // about the session, no result envelope, non-zero exit.
    { match: { promptIncludes: 'legacy resume', resume: true },
      crash: 1, stderr: 'No conversation found with session ID: stale. Session not found.' },
    // The retry (sessionId stripped, _resumeRetry set) spawns fresh and answers.
    { match: { promptIncludes: 'legacy resume', resume: false },
      turn: [{ text: 'LEGACY-FRESH-ANSWER.' }] },
  ]);
  const since = client.messages.length;
  client.send({ type: 'chat', conversationId: convoId, agent: 'chief-of-staff', content: 'legacy resume please', sessionId: 'stale-sess-1' });
  const { index: pillIdx, msg: pill } = await client.waitFor(
    m => m.type === 'system' && m.subtype === 'info' && m._conversationId === convoId && /session expired/i.test(m.content || ''),
    { since, label: 'expired-session pill' });
  assert.match(pill.content, /Starting fresh/);
  await client.waitFor(m => m.type === 'system' && m.subtype === 'done' && m._conversationId === convoId, { since: pillIdx, label: 'done from the fresh retry' });
  // The fresh turn's done is sent at result time; the map delete happens in
  // the close handler moments later. Wait for the close, not just the done.
  const deadline = Date.now() + 2000;
  while (h.internal.chatProcesses.has(convoId) && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 20));
  }
  assert.ok(!h.internal.chatProcesses.has(convoId), 'the retried entry is cleaned up on close');
});

test('legacy close flush: a complete JSON object left in the line buffer is delivered parsed', async () => {
  const convoId = h.freshConvoId('legacybuf');
  h.writeScenario([
    // crashTail is written WITHOUT a trailing newline, so it is still in the
    // server's line buffer when the process dies; the close handler parses it.
    { match: { promptIncludes: 'legacy tail-json' },
      crash: 0, crashTail: '{"type":"assistant","message":{"content":[{"type":"text","text":"TAIL-FLUSHED"}]}}' },
  ]);
  const since = client.messages.length;
  client.send({ type: 'chat', conversationId: convoId, agent: 'chief-of-staff', content: 'legacy tail-json' });
  const { msg: flushed } = await client.waitFor(
    m => m.type === 'assistant' && m._conversationId === convoId && JSON.stringify(m).includes('TAIL-FLUSHED'),
    { since, label: 'parsed buffer flush' });
  assert.strictEqual(flushed._agent, 'chief-of-staff', 'the flush is enriched with the entry metadata');
  await client.waitFor(m => m.type === 'system' && m.subtype === 'done' && m._conversationId === convoId, { since, label: 'done after flush' });
});

test('legacy close flush: a non-JSON fragment degrades to a raw message, never a crash', async () => {
  const convoId = h.freshConvoId('legacyraw');
  h.writeScenario([
    { match: { promptIncludes: 'legacy tail-raw' },
      crash: 0, crashTail: 'not json at all' },
  ]);
  const since = client.messages.length;
  client.send({ type: 'chat', conversationId: convoId, agent: 'chief-of-staff', content: 'legacy tail-raw' });
  const { msg: raw } = await client.waitFor(m => m.type === 'raw' && m._conversationId === convoId, { since, label: 'raw fallback' });
  assert.match(raw.content, /not json at all/);
  await client.waitFor(m => m.type === 'system' && m.subtype === 'done' && m._conversationId === convoId, { since, label: 'done after raw flush' });
});

test('a handler throwing inside the message loop is contained: the connection keeps serving', async () => {
  // set_workspace into a directory whose .rundock is a FILE throws in the
  // handler (the carded silent-no-reply gap). This test pins CONTAINMENT
  // only: the loop's catch swallows the throw and the connection stays
  // usable. It deliberately does NOT pin the missing error reply, so the
  // carded fix (answer with a workspace_error) lands without touching this.
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rundock-broken-ws-'));
  fs.writeFileSync(path.join(dir, '.rundock'), 'a file, not a directory');
  try {
    const since = client.messages.length;
    client.send({ type: 'set_workspace', path: dir });
    client.send({ type: 'get_workspaces' });
    const { msg } = await client.waitFor(m => m.type === 'workspaces', { since, label: 'loop alive after handler throw' });
    assert.ok(msg, 'the message loop survived the throwing handler');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
