'use strict';
// A SERVER STARTED WITH ITS WORKSPACE SAVES ITS CONVERSATIONS THERE.
//
// A workspace remembered at startup reaches the server through the
// environment and never through a switch, so nothing that only happens on a
// switch can be what tells a transcript which workspace it belongs to.
// presetWorkspace hands the suite's workspace over that way and leaves the
// setter untouched. It has its own file because the harness boots one server
// per file.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const h = require('../helpers/harness.js');
const { makeWorkspace, standardTeam } = require('../helpers/workspace.js');

let client;

before(async () => {
  await h.boot({ presetWorkspace: true });
  client = await h.connect();
});
after(h.shutdown);

const transcriptFile = (dir, id) => path.join(dir, '.rundock', 'transcripts', `${id}.json`);
function said(dir, id) {
  assert.ok(fs.existsSync(transcriptFile(dir, id)), 'the conversation has a transcript in that workspace');
  return JSON.parse(fs.readFileSync(transcriptFile(dir, id), 'utf-8')).map((r) => `${r.role}: ${r.text}`);
}
async function resultFor(id, since, label) {
  await client.waitFor((m) => m.type === 'result' && m._conversationId === id, { since, label, timeout: 15000 });
}

// This passes without the fix as well, by design. The test below shares its
// start, a conversation in a server started with its workspace, and fails
// without the fix.
test('a conversation in a server started with its workspace saves there', async () => {
  const id = h.freshConvoId('boot');
  const tag = crypto.randomBytes(4).toString('hex');
  const ask = `ASK-${tag} where is the plan?`;
  h.writeScenario([{ match: { agent: 'chief-of-staff', promptIncludes: `ASK-${tag}` }, turn: [{ text: `ANSWER-${tag}` }] }]);
  try {
    const since = client.messages.length;
    client.send({ type: 'chat', conversationId: id, agent: 'chief-of-staff', content: ask });
    await resultFor(id, since, 'the reply');
    assert.deepStrictEqual(said(h.workspaceDir, id), [`user: ${ask}`, `agent: ANSWER-${tag}`]);
  } finally {
    h.reapConvo(id);
  }
});

test('a reply that ends after set_workspace, in a server started with its workspace, is kept there and writes nothing into the workspace opened', async () => {
  const id = h.freshConvoId('boot-late');
  const tag = crypto.randomBytes(4).toString('hex');
  const ask = `ASK-${tag} where is the plan?`;
  const reply = `REPLY-${tag} The plan is in the shared folder, under this quarter.`;
  const second = makeWorkspace({ claudeMd: '# Second fixture\n', agents: standardTeam() });
  h.writeScenario([{
    match: { agent: 'chief-of-staff', promptIncludes: `ASK-${tag}` },
    holdAfterText: path.join(h.workspaceDir, `never-${id}`), finishOnSigterm: true, turn: [{ text: reply }],
  }]);
  try {
    const since = client.messages.length;
    client.send({ type: 'chat', conversationId: id, agent: 'chief-of-staff', content: ask });
    await client.waitFor((m) => m.type === 'stream_event' && m._conversationId === id && m.event && m.event.type === 'content_block_stop',
      { since, label: 'the reply text streamed' });
    const switched = client.messages.length;
    client.send({ type: 'set_workspace', path: second });
    await client.waitFor((m) => m.type === 'workspace_set', { since: switched, label: 'the switch' });
    await resultFor(id, since, 'the reply finished after the switch');
    assert.strictEqual(fs.existsSync(transcriptFile(second, id)), false, 'the workspace opened has no transcript for the conversation');
    assert.deepStrictEqual(said(h.workspaceDir, id), [`user: ${ask}`, `agent: ${reply}`]);
  } finally {
    h.reapConvo(id);
  }
});
