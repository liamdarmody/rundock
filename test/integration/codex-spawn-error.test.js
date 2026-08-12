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
