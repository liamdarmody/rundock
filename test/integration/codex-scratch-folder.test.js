'use strict';
// Integration: the scratch folder a Codex agent is told to use is there when
// its thread starts, in a workspace where no Claude Code agent has run.
//
// The folder used to be made only by the Claude Code spawn environment, so in
// a workspace where only Codex agents ran it never existed, and a Codex agent
// that wrote a scratch file by shell redirect, as told, got "No such file or
// directory". The stub codex records what the folder and its ignore marker
// held at the moment each request arrived (`observePaths` in its scenario),
// so this asserts the state on disk when thread/start reached it, not after
// the turn. No Claude Code agent is sent a message anywhere in this file.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
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

const codexRequests = (method) => h.readInvocations().filter(i => i.mode === 'app-server' && i.method === method);

describe('a workspace where only a Codex agent runs', () => {
  for (const mode of ['notes', 'code']) {
    test(`${mode} mode: the scratch folder and its ignore marker exist when thread/start arrives`, async () => {
      await setMode(mode);
      const scratch = path.join(h.workspaceDir, '.rundock', 'scratch');
      const marker = path.join(scratch, '.gitignore');
      // Made by the test before this one, in the other mode: taken away, so
      // each mode starts with no folder.
      fs.rmSync(scratch, { recursive: true, force: true });
      assert.ok(!fs.existsSync(scratch), 'no scratch folder before the turn');

      h.clearInvocations();
      h.writeCodexScenario([{ match: { promptIncludes: 'scratch folder question' }, text: 'Noted.' }],
        { observePaths: [scratch, marker] });
      const convo = h.freshConvoId('cdx-folder');
      client.send({ type: 'chat', conversationId: convo, agent: 'researcher', content: 'scratch folder question' });
      await client.waitForEvent('system', 'done', convo);

      assert.deepStrictEqual(h.readInvocations().filter(i => i.bin !== 'codex'), [], 'no Claude Code agent started');
      const starts = codexRequests('thread/start');
      assert.strictEqual(starts.length, 1, 'one thread');
      assert.deepStrictEqual(starts[0].observed, { [scratch]: 'dir', [marker]: '*\n' },
        'the folder, ignoring itself, was there when the thread was asked for');

      // And it is the folder the first turn tells the agent to use.
      const [turn] = h.codexTurnPrompts();
      const named = /use the folder `([^`]+)`/.exec(turn);
      assert.ok(named, 'the first turn names a scratch folder');
      assert.strictEqual(named[1], scratch + path.sep);

      h.reapConvo(convo);
    });
  }
});
