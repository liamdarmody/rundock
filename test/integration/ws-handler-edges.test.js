'use strict';
// Characterisation: WS handler branches made VISIBLE by the slice-9 move.
// Inside server.js's monolithic message closure, V8's block coverage smeared
// whole handler bodies with the enclosing block's count (both arms of
// mutually exclusive branches reported identical hits), so these paths
// measured as covered without ever being driven. As small top-level
// functions in lib/protocol/handlers/ the instrument now sees the truth;
// these tests drive each branch for real, over a live WebSocket.
//
// Ordering matters: two tests SWITCH the live workspace and restore it, and
// the create_workspace failure test corrupts the temp HOME's Documents
// entry and removes it again.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const h = require('../helpers/harness.js');
const { makeTempDir } = require('../helpers/workspace.js');

let client;

before(async () => {
  await h.boot();
  client = await h.connect();
});
after(async () => h.shutdown());

function request(msg, pred, label) {
  const since = client.messages.length;
  client.send(msg);
  return client.waitFor(pred, { since, label }).then(r => r.msg);
}

describe('workspace lifecycle edges', () => {
  test('set_workspace to a missing directory answers the user-facing error and switches nothing', async () => {
    const before = h.internal.getWorkspace();
    const res = await request(
      { type: 'set_workspace', path: path.join(os.tmpdir(), 'rundock-no-such-dir-anywhere') },
      m => m.type === 'workspace_error', 'workspace_error');
    assert.strictEqual(res.message, 'Directory not found');
    assert.strictEqual(h.internal.getWorkspace(), before, 'the live workspace is untouched');
  });

  test('set_workspace to an EMPTY directory scaffolds defaults and says so', async () => {
    const dir = makeTempDir('rundock-test-empty-ws-');
    try {
      const since = client.messages.length;
      client.send({ type: 'set_workspace', path: dir });
      const wsSet = (await client.waitFor(m => m.type === 'workspace_set', { since, label: 'workspace_set empty' })).msg;
      assert.strictEqual(wsSet.path, dir);
      assert.strictEqual(wsSet.isEmpty, true, 'an agent-less, file-less directory is empty');
      assert.strictEqual(wsSet.scaffoldError, null, 'the scaffold succeeded');
      assert.ok(fs.existsSync(path.join(dir, 'CLAUDE.md')), 'scaffold defaults written to disk');
      // The boot set still follows: roster and file tree without asking.
      await client.waitFor(m => m.type === 'agents', { since, label: 'agents after empty open' });
      await client.waitFor(m => m.type === 'file_tree', { since, label: 'file_tree after empty open' });
    } finally {
      h.internal.setWorkspace(h.workspaceDir);
    }
  });

  test('set_workspace_mode surfaces a persistence failure as a workspace_error', async () => {
    // .rundock as a FILE makes writeState throw (the slice-3 trick). The
    // switch itself happens through the internal seam: the WS open path
    // cannot enter a workspace whose .rundock is a file (its prepare steps
    // throw into the message-loop catch and answer nothing; recorded as a
    // discovered edge, not driven here).
    const dir = makeTempDir('rundock-test-badmode-');
    fs.writeFileSync(path.join(dir, 'notes.md'), '# not empty\n');
    try {
      h.internal.setWorkspace(dir);
      fs.writeFileSync(path.join(dir, '.rundock'), 'not a directory');
      const res = await request({ type: 'set_workspace_mode', mode: 'code' },
        m => m.type === 'workspace_error', 'workspace_error mode');
      assert.match(res.message, /^Could not update workspace mode: /,
        'the failure carries the mode wording, not a silent success');
    } finally {
      h.internal.setWorkspace(h.workspaceDir);
    }
  });

  test('create_workspace surfaces a creation failure as a workspace_error and switches nothing', async () => {
    // HOME is the harness temp home. Documents as a FILE makes the
    // recursive mkdir throw before any switch happens.
    const docs = path.join(process.env.HOME, 'Documents');
    const hadDocs = fs.existsSync(docs);
    if (hadDocs) fs.renameSync(docs, docs + '.bak');
    fs.writeFileSync(docs, 'not a directory');
    const before = h.internal.getWorkspace();
    try {
      const res = await request({ type: 'create_workspace', name: 'EdgeFail' },
        m => m.type === 'workspace_error', 'workspace_error create');
      assert.match(res.message, /^Could not create workspace: /);
      assert.strictEqual(h.internal.getWorkspace(), before, 'no switch on failure');
    } finally {
      fs.rmSync(docs, { force: true });
      if (hadDocs) fs.renameSync(docs + '.bak', docs);
    }
  });
});

describe('team CRUD edges', () => {
  test('add_to_team on an agent that already has an order REPLACES it with the next order', async () => {
    // Find the current maximum order, then re-add an already-on-team agent.
    const agents = (await request({ type: 'get_agents' }, m => m.type === 'agents', 'agents')).agents;
    const onTeam = agents.filter(a => a.order !== null && a.fileName);
    assert.ok(onTeam.length >= 2, 'fixture team has ordered agents');
    const maxOrder = Math.max(...onTeam.map(a => a.order));
    const target = onTeam[0];
    const updated = (await request({ type: 'add_to_team', agentId: target.id },
      m => m.type === 'agents', 'agents after re-add')).agents;
    const moved = updated.find(a => a.id === target.id);
    assert.strictEqual(moved.order, maxOrder + 1, 'the existing order line was replaced, not duplicated');
    const file = fs.readFileSync(path.join(h.workspaceDir, '.claude', 'agents', target.fileName), 'utf-8');
    assert.strictEqual((file.match(/^order:\s/gm) || []).length, 1, 'exactly one order line');
  });

  // NOTE (discovered during this characterisation): add_to_team on an agent
  // whose frontmatter has a description but no type line writes the order
  // OUTSIDE the frontmatter (the fallback regex jumps the closing fence into
  // the body), so the join silently does nothing. Deliberately NOT pinned
  // here: pinning would freeze a bug. The red-first fix ships separately.

  test('save_agent with type but no order gains an order after the type line', async () => {
    const res = await request({
      type: 'save_agent', name: 'edge-typed',
      content: '---\nname: Edge Typed\ndescription: Typed bench agent.\ntype: specialist\n---\n\nBody.\n',
    }, m => m.type === 'agent_saved', 'agent_saved');
    assert.strictEqual(res.updated, false, 'created, not updated');
    const saved = fs.readFileSync(path.join(h.workspaceDir, '.claude', 'agents', 'edge-typed.md'), 'utf-8');
    assert.match(saved, /type: specialist\norder: \d+/, 'order inserted directly after type');
  });

  test('save_skill and delete_skill refuse bad names and missing skills with their own wordings', async () => {
    const bad = await request({ type: 'save_skill', name: 'Bad Name!', content: '# nope' },
      m => m.type === 'skill_error', 'skill_error name');
    assert.match(bad.message, /^Invalid skill name\. Use lowercase letters/);
    const missing = await request({ type: 'delete_skill', name: 'never-existed' },
      m => m.type === 'skill_error', 'skill_error missing');
    assert.strictEqual(missing.message, 'Skill "never-existed" not found.');
  });
});

describe('search edges', () => {
  test('an empty search query answers an empty result set immediately', async () => {
    const res = await request({ type: 'search_conversations', query: '   ' },
      m => m.type === 'search_results', 'search_results empty');
    assert.deepStrictEqual(res.results, []);
  });
});
