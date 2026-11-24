'use strict';
// Characterization: the codex spawn-failure surface, pinned ahead of the
// codex glue's extraction. A machine without the Codex CLI gets the
// codex-specific install guidance (NOT the Claude-install message), a clean
// done so the client unblocks, and a 30s per-conversation dedupe so retries
// against a missing binary never stack pills.
//
// Own file, own process: after boot, PATH is REPLACED with a minimal
// whitelist (claude stub + node's own dir + system dirs) that contains no
// codex anywhere. Filtering only the stub's directory out is NOT enough: a
// developer machine with the real CLI installed would resolve and spawn it,
// which is exactly what the harness boot assertion exists to prevent. With
// the whitelist, `which codex` finds nothing, the resolver falls back to
// the bare name, and the spawn fails with ENOENT exactly as on a machine
// without the CLI.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const h = require('../helpers/harness.js');
const { agentFile, standardTeam } = require('../helpers/workspace.js');

let client;
let originalPath;

before(async () => {
  await h.boot({
    agents: {
      ...standardTeam(),
      'researcher': agentFile({
        name: 'researcher', displayName: 'Ida', role: 'Researcher',
        description: 'Researches suppliers', type: 'specialist', order: 5,
        reportsTo: 'chief-of-staff', runtime: 'codex',
        body: 'You are Ida, the researcher.',
      }),
    },
  });
  client = await h.connect();
  originalPath = process.env.PATH;
  const claudeStubDir = path.join(__dirname, '..', 'helpers', 'stub-claude');
  process.env.PATH = [
    claudeStubDir,
    path.dirname(process.execPath), // node itself, for the stub's shebang
    '/usr/bin', '/bin', '/usr/sbin', '/sbin',
  ].join(path.delimiter);
});
after(async () => {
  if (originalPath) process.env.PATH = originalPath;
  await h.shutdown();
});

const INSTALL_GUIDANCE = /Codex CLI was not found/;

test('a missing codex binary surfaces install guidance and a clean done', async () => {
  const convoId = h.freshConvoId('cnobin');
  const since = client.messages.length;
  client.send({ type: 'chat', conversationId: convoId, agent: 'researcher', content: 'hello codex' });

  const { msg: info } = await client.waitFor(
    m => m.type === 'system' && m.subtype === 'info' && m._conversationId === convoId,
    { since, label: 'install guidance' });
  assert.match(info.content, INSTALL_GUIDANCE, 'codex-specific guidance, never the Claude-install message');
  // A missing binary says nothing about any session, so the window it reaches
  // forgets nothing: run through the window's own reducer, a live primary
  // session survives it.
  assert.strictEqual(info.expiredSessionId, undefined, 'it names no session');
  const { createState, reduce } = require('../../public/conversation-state.js');
  assert.deepStrictEqual(reduce(createState(), info, { hasPrimarySession: true }).effects,
    [{ type: 'notice', content: info.content }], 'a notice, and nothing forgotten');
  const { msg: done } = await client.waitFor(
    m => m.type === 'system' && m.subtype === 'done' && m._conversationId === convoId,
    { since, label: 'done after spawn failure' });
  assert.strictEqual(done.code, -1);
});

test('a retry within 30s is deduped: done arrives, the guidance does not stack', async () => {
  // SAME conversation as the previous attempt would be ideal, but each test
  // owns its convo; the dedupe window is per conversation, so drive both
  // attempts here.
  const convoId = h.freshConvoId('cdedupe');
  const since = client.messages.length;
  client.send({ type: 'chat', conversationId: convoId, agent: 'researcher', content: 'first try' });
  await client.waitFor(
    m => m.type === 'system' && m.subtype === 'done' && m._conversationId === convoId,
    { since, label: 'first failure done' });

  const sinceRetry = client.messages.length;
  client.send({ type: 'chat', conversationId: convoId, agent: 'researcher', content: 'second try' });
  await client.waitFor(
    m => m.type === 'system' && m.subtype === 'done' && m._conversationId === convoId,
    { since: sinceRetry, label: 'deduped failure done' });

  const guidance = client.messages.slice(since).filter(
    m => m.type === 'system' && m.subtype === 'info' && m._conversationId === convoId
      && INSTALL_GUIDANCE.test(m.content || ''));
  assert.strictEqual(guidance.length, 1, 'the second failure inside the window sends done only');
});

// A delegate whose start failed on a missing binary has already been told so
// by the guidance above. Its close is not a stop: no line, sent or stored,
// and no card beside the guidance. The parent was parked for it and is not
// restored here, as before.
test('a codex delegate that could not be started sends no line, and the guidance is its only notice', async () => {
  const convoId = h.freshConvoId('cdelegate-nobin');
  h.writeScenario([
    { match: { agent: 'chief-of-staff', promptIncludes: 'cdelegate-nobin open' }, turn: [{ text: 'ready' }] },
  ]);
  client.send({ type: 'chat', conversationId: convoId, agent: 'chief-of-staff', content: 'cdelegate-nobin open' });
  await client.waitForEvent('system', 'done', convoId);

  const since = client.messages.length;
  client.send({ type: 'delegate', conversationId: convoId, targetAgent: 'researcher', context: 'cdelegate-nobin task' });
  await client.waitFor(
    m => m.type === 'system' && m.subtype === 'done' && m._conversationId === convoId && m._agent === 'researcher' && m.code === -1,
    { since, label: 'Ida\'s failed start is done' });
  // Her close leaves her entry marked exited, or, had it gone on to decide,
  // would have handed the conversation back to Cos.
  assert.ok(await h.waitUntil(() => {
    const e = h.internal.chatProcesses.get(convoId) || {};
    return e.exited === true || e.agentId === 'chief-of-staff';
  }), 'Ida\'s close has run');

  // The history reply goes out after anything the close sent.
  const asked = client.messages.length;
  client.send({ type: 'get_session_history', conversationId: convoId, sessionIds: [], limit: 200 });
  await client.waitFor(m => m.type === 'session_history' && m.conversationId === convoId,
    { since: asked, label: 'the history request was answered' });
  const seen = client.messages.slice(since);

  const guidance = seen.filter(m => m.type === 'system' && m.subtype === 'info' && m._conversationId === convoId
    && INSTALL_GUIDANCE.test(m.content || ''));
  assert.strictEqual(guidance.length, 1, 'sanity: the guidance said Ida could not be started');
  assert.deepStrictEqual(seen.filter(m => m.type === 'system' && m.subtype === 'delegate_stopped'
    && m._conversationId === convoId).map(m => m.content), [], 'no line is sent');
  assert.deepStrictEqual((h.internal.loadTranscript(convoId) || []).filter(t => t.type === 'delegation').map(t => t.text), [],
    'and none is stored');
  assert.deepStrictEqual(seen.filter(m => m.type === 'system' && m._conversationId === convoId
    && ['codex_error', 'codex_quota', 'codex_guidance', 'notice'].includes(m.subtype)).map(m => m.subtype), [],
  'the guidance is the only notice');
  assert.deepStrictEqual(seen.filter(m => m.type === 'system' && m.subtype === 'agent_switch'
    && m._conversationId === convoId && m.failed), [], 'no switch says Ida stopped');
  h.reapConvo(convoId);
});
