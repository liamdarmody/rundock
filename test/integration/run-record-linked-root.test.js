'use strict';
// A run in a workspace opened through a symbolic link, and the run screen's
// link check.
//
// THE FACT THIS RESTS ON, from the committed transcript capture
// (scripts/transcript-truth, `recordedPaths`): a run spawned in a folder
// reached through a symbolic link records its working directory and every
// file it wrote under the folder the link resolves to, not the spelling it
// was spawned with. The scheduler spawns a run with its working directory set
// to the workspace as the server holds it, so for a workspace opened through
// a link the record's paths and the client's root are two spellings of one
// folder, and an exact prefix check would leave every name plain.
//
// The stub runtime resolves a relative write against its own working
// directory, which the operating system hands it resolved, so it records
// paths the same way. This test opens the workspace through a link it makes
// itself, so the case does not depend on where the machine's temporary
// folder happens to live.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const h = require('../helpers/harness.js');
const { agentFile } = require('../helpers/workspace.js');
const scheduler = require('../../lib/scheduler.js');
const model = require('../../public/run-detail-model.js');

const WROTE = 'Run output/linked-from-run.md';
let client;
let link;
let linkHome;

before(async () => {
  await h.boot({
    agents: {
      writer: agentFile({
        name: 'writer', type: 'specialist', order: 1,
        routines: [{ name: 'sweep', schedule: 'every day at 05:00', prompt: 'linked sweep', enabled: true }],
      }),
    },
  });
  h.writeScenario([{ match: { agent: 'writer' }, writes: [{ file: WROTE }], turn: [{ text: 'done' }] }]);
  h.internal.stopScheduler();
  linkHome = fs.mkdtempSync(path.join(os.tmpdir(), 'rundock-linked-root-'));
  link = path.join(linkHome, 'workspace');
  fs.symlinkSync(h.workspaceDir, link, 'dir');
  h.internal.setWorkspace(link);
  client = await h.connect();
});

after(async () => {
  await h.shutdown();
  fs.rmSync(linkHome, { recursive: true, force: true });
});

test('a run in a workspace opened through a link records the resolved folder, and its names still link', async () => {
  client.send({ type: 'run_routine_now', agentId: 'writer', name: 'sweep', occurrence: 0 });
  assert.ok(await h.waitUntil(() => scheduler.readRunRecords().some(r => r.routine === 'sweep' && r.endedAt), 20000),
    'the run ended and closed its record');

  const since = client.messages.length;
  client.send({ type: 'get_run', agentId: 'writer', routine: 'sweep' });
  const { msg: reply } = await client.waitFor(m => m.type === 'run', { since, label: 'the run record' });
  assert.strictEqual(reply.run.filesStatus, 'known', 'the run\'s list is known');
  assert.strictEqual(reply.workspace, link, 'the reply names the workspace as the server holds it');
  assert.strictEqual(reply.workspaceRealPath, fs.realpathSync.native(link), 'and the folder it resolves to');

  const [file] = reply.run.files;
  assert.ok(file, 'the run recorded the file it wrote');
  assert.ok(file.path.startsWith(reply.workspaceRealPath + path.sep),
    'the record\'s path is the resolved folder, then one separator');
  assert.ok(!file.path.startsWith(link + path.sep),
    'and not the spelling the workspace was opened with: on this platform the two differ');

  const tree = h.internal.getFileTree(link);
  assert.strictEqual(model.treePathFor(file.path, reply.workspace, tree), null,
    'against the opened spelling alone the name would stay plain');
  assert.strictEqual(model.treePathFor(file.path, [reply.workspace, reply.workspaceRealPath], tree), WROTE,
    'against both spellings of the one folder it links to the tree\'s own path');
});
