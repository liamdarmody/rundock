'use strict';
// Integration: a Codex thread is told the full path of the workspace scratch
// folder, and that folder is inside what the thread is started able to write.
//
// Real server.js, real WebSocket, the real app-server client
// (codex-appserver.js) speaking JSON-RPC over stdio to the stub codex binary.
// Every assertion reads what the stub received on that transport, from the log
// it appends to in the fixture workspace: the thread/start and turn/start
// requests exactly as they arrived, not an in-process stand-in for the server.
// The paragraph is compared with the one the stub claude received in
// --append-system-prompt for a Claude Code agent in the same workspace and
// mode, so both runtimes are held to the same words.
//
// WHAT THIS CANNOT SHOW: that Codex's own sandbox lets a write at that path
// through without asking. That enforcement is Codex's code and needs the real,
// signed-in binary. What Rundock controls, and what this pins, is the sandbox
// it asks for: workspace-write with the workspace as the thread's cwd, and no
// per-turn override that could move or narrow it. What Codex does with those
// options is documented in docs/protocol/codex-app-server/RESEARCH.md
// (sections 3, 5 and 8).
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const h = require('../helpers/harness.js');
const { agentFile, standardTeam } = require('../helpers/workspace.js');

let client;

function team() {
  return {
    ...standardTeam(),
    'researcher': agentFile({
      name: 'researcher', displayName: 'Ida', role: 'Researcher',
      description: 'Researches suppliers', type: 'specialist', order: 5,
      reportsTo: 'chief-of-staff', runtime: 'codex',
      body: 'You are Ida, the researcher.',
    }),
  };
}

before(async () => {
  await h.boot({ agents: team() });
  client = await h.connect();
});
after(async () => h.shutdown());

async function setMode(mode) {
  const since = client.messages.length;
  client.send({ type: 'set_workspace_mode', mode });
  await client.waitFor(m => m.type === 'workspace_mode_changed' && m.mode === mode, { since, label: `mode ${mode}` });
  assert.strictEqual(h.internal.readState().workspaceMode, mode);
}

// The lines between the SCRATCH FILES heading and the next blank line.
function scratchParagraph(prompt) {
  const lines = prompt.split('\n');
  const at = lines.indexOf('SCRATCH FILES:');
  assert.ok(at >= 0, `the prompt has a SCRATCH FILES section:\n${prompt.slice(0, 400)}`);
  const end = lines.indexOf('', at);
  return lines.slice(at + 1, end).join('\n');
}

// The folder the paragraph tells an agent to use, as it is written there.
function namedFolder(paragraph) {
  const m = /use the folder `([^`]+)`/.exec(paragraph);
  assert.ok(m, `the paragraph names a folder:\n${paragraph}`);
  return m[1];
}

// Requests the stub codex received, by JSON-RPC method.
const codexRequests = (method) => h.readInvocations().filter(i => i.mode === 'app-server' && i.method === method);

// The system prompt the stub claude was started with, for each Claude spawn.
const claudeSystemPrompts = () => h.readInvocations()
  .filter(i => i.bin !== 'codex' && Array.isArray(i.argv) && i.argv.includes('--append-system-prompt'))
  .map(i => i.argv[i.argv.indexOf('--append-system-prompt') + 1]);

describe('a Codex thread, through the real server and the stub Codex', () => {
  for (const mode of ['notes', 'code']) {
    test(`${mode} mode: the first turn carries the paragraph naming the scratch folder, and the thread may write there`, async () => {
      await setMode(mode);
      h.clearInvocations();
      h.writeCodexScenario([{ match: { promptIncludes: 'codex scratch question' }, text: 'Noted.' }]);
      h.writeScenario([{ match: {}, turn: [{ text: 'Noted.' }] }]);

      // A Codex agent first, so nothing a Claude spawn sets up is in place yet.
      const codexConvo = h.freshConvoId('cdx-scratch');
      client.send({ type: 'chat', conversationId: codexConvo, agent: 'researcher', content: 'codex scratch question' });
      const { msg: init } = await client.waitForEvent('system', 'init', codexConvo);
      await client.waitForEvent('system', 'done', codexConvo);

      const claudeConvo = h.freshConvoId('cc-scratch');
      client.send({ type: 'chat', conversationId: claudeConvo, agent: 'content-lead', content: 'claude scratch question' });
      await client.waitForEvent('system', 'done', claudeConvo);

      // THE THREAD. The whole request, not a few fields of it: a `config`
      // override, writable roots or a profile would each change where Codex may
      // write, so any new field belongs here, where it is judged against this.
      const starts = codexRequests('thread/start');
      assert.strictEqual(starts.length, 1, 'one thread for the conversation');
      assert.deepStrictEqual(starts[0].params, {
        cwd: h.workspaceDir,
        sandbox: 'workspace-write',
        approvalPolicy: 'on-request',
        approvalsReviewer: 'user',
      }, 'workspace-write, rooted at the workspace, with nothing narrowing it');

      // THE FIRST TURN, on that thread. Per-turn settings take precedence over
      // the thread's, so a turn that sent its own cwd or sandbox policy could
      // move the root the thread was started with.
      const turns = codexRequests('turn/start');
      assert.strictEqual(turns.length, 1, 'one turn');
      const turn = turns[0].params;
      assert.strictEqual(turn.threadId, init._sessionId, 'the turn runs on the thread started above');
      assert.deepStrictEqual(Object.keys(turn).sort(), ['input', 'threadId'], 'no per-turn cwd or sandbox override');
      const texts = turn.input.filter(p => p && p.type === 'text').map(p => p.text);
      assert.strictEqual(texts.length, 1, 'the prompt is one text input');
      assert.ok(texts[0].includes('You are Ida'), 'it is the first-turn prompt, with the agent identity');

      // THE PARAGRAPH, word for word what a Claude Code agent is started with.
      const said = scratchParagraph(texts[0]);
      const claude = claudeSystemPrompts();
      assert.strictEqual(claude.length, 1, 'one Claude Code agent started');
      assert.strictEqual(said, scratchParagraph(claude[0]), 'the paragraph a Claude Code agent gets, byte for byte');

      // THE FOLDER: the workspace's own scratch folder, by its full path, and
      // inside the root the thread may write.
      const folder = namedFolder(said);
      assert.strictEqual(folder, path.join(h.workspaceDir, '.rundock', 'scratch') + path.sep);
      assert.ok(folder.startsWith(starts[0].params.cwd + path.sep), 'inside the thread cwd, so inside its writable root');

      h.reapConvo(codexConvo);
      h.reapConvo(claudeConvo);
    });
  }
});
