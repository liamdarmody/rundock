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

  test('set_workspace into a workspace whose .rundock is a FILE answers an error and stays put', async () => {
    // Discovered during the handler characterisation: the prepare steps
    // threw into the message-loop catch AFTER the root had already switched,
    // so the client got NO reply and the server was left half-switched.
    const before = h.internal.getWorkspace();
    const dir = makeTempDir('rundock-test-brokenrd-');
    fs.writeFileSync(path.join(dir, 'notes.md'), '# not empty\n');
    fs.writeFileSync(path.join(dir, '.rundock'), 'a file, not a directory');
    try {
      const res = await request({ type: 'set_workspace', path: dir },
        m => m.type === 'workspace_error', 'workspace_error broken .rundock');
      assert.match(res.message, /\.rundock/, 'the error names the broken .rundock');
      assert.strictEqual(h.internal.getWorkspace(), before,
        'the previous workspace remains active: no half-switch');
    } finally {
      h.internal.setWorkspace(h.workspaceDir);
    }
  });

  // openWorkspace persists the auto-detected mode BEFORE calling
  // scaffoldWorkspace, because scaffoldWorkspace's own reconcile reads the
  // mode back off disk (workspaceModeFor), not from the caller's in-memory
  // state. A never-before-opened directory has no state.json yet, so if the
  // persist ever moved back to AFTER the scaffold call, workspaceModeFor
  // would read the file's absence, default to knowledge, and write the
  // block into a code-signal workspace on its very first open, catching up
  // only on the NEXT one. Driven through the real dispatch path (set_workspace),
  // not scaffoldWorkspace directly, so the ordering itself is what is proven.
  test('a never-before-opened workspace gets the right block on its FIRST open, mode auto-detected: none for a code signal, one without', async () => {
    const realPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    try {
      const codeDir = makeTempDir('rundock-test-firstopen-code-');
      fs.writeFileSync(path.join(codeDir, 'package.json'), '{}');
      try {
        const since = client.messages.length;
        client.send({ type: 'set_workspace', path: codeDir });
        const wsSet = (await client.waitFor(m => m.type === 'workspace_set', { since, label: 'first open, code signal' })).msg;
        assert.strictEqual(wsSet.workspaceMode, 'code', 'auto-detected as code from the package.json');
        const settings = JSON.parse(fs.readFileSync(path.join(codeDir, '.claude', 'settings.local.json'), 'utf8'));
        assert.strictEqual('sandbox' in settings, false,
          'no block on the first open of a code-signal workspace, not one only withdrawn on the second');
      } finally {
        h.internal.setWorkspace(h.workspaceDir);
      }

      const knowledgeDir = makeTempDir('rundock-test-firstopen-knowledge-');
      fs.writeFileSync(path.join(knowledgeDir, 'notes.md'), '# just notes\n');
      try {
        const since = client.messages.length;
        client.send({ type: 'set_workspace', path: knowledgeDir });
        const wsSet = (await client.waitFor(m => m.type === 'workspace_set', { since, label: 'first open, no code signal' })).msg;
        assert.strictEqual(wsSet.workspaceMode, 'knowledge', 'auto-detected as knowledge: nothing code-shaped here');
        const settings = JSON.parse(fs.readFileSync(path.join(knowledgeDir, '.claude', 'settings.local.json'), 'utf8'));
        assert.ok(settings.sandbox, 'the block is present on the first open of a knowledge-mode workspace');
      } finally {
        h.internal.setWorkspace(h.workspaceDir);
      }
    } finally {
      Object.defineProperty(process, 'platform', { value: realPlatform });
    }
  });

  test('set_workspace_mode surfaces a persistence failure as a workspace_error', async () => {
    // .rundock as a FILE makes writeState throw (the slice-3 trick). The
    // switch happens through the internal seam because the WS open path now
    // REFUSES a workspace whose .rundock is a file (see the broken-.rundock
    // test above).
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

  test('add_to_team on a name+description-only agent lands the order INSIDE the frontmatter', async () => {
    // Discovered during the handler characterisation: the old fallback regex
    // jumped the closing fence and wrote `order:` into the BODY, so discovery
    // never saw it and the join silently did nothing.
    const body = 'You are a minimal bench agent.\n\nNo type line above, on purpose.\n';
    fs.writeFileSync(path.join(h.workspaceDir, '.claude', 'agents', 'edge-minimal.md'),
      `---\nname: Edge Minimal\ndescription: Minimal bench agent.\n---\n${body}`);
    h.internal.invalidateAgentCache();
    const updated = (await request({ type: 'add_to_team', agentId: 'edge-minimal' },
      m => m.type === 'agents', 'agents after minimal join')).agents;
    const joined = updated.find(a => a.id === 'edge-minimal');
    assert.ok(joined, 'the agent is discovered');
    assert.ok(Number.isInteger(joined.order) && joined.order > 0,
      'the roster broadcast shows the agent ON the team (order assigned)');
    const file = fs.readFileSync(path.join(h.workspaceDir, '.claude', 'agents', 'edge-minimal.md'), 'utf-8');
    const fm = file.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
    assert.ok(fm, 'frontmatter still well-formed');
    assert.match(fm[1], /^order: \d+$/m, 'order landed INSIDE the frontmatter');
    assert.strictEqual(fm[2], body, 'the body is untouched');
  });

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
