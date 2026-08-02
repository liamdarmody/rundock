'use strict';
// Integration: a workspace that has been moved, renamed, or copied to another
// machine carries state that quietly assumed its old absolute path.
//
// A user zipped a vault, brought it into their workspace including the hidden
// folders, and had unexplained slowness afterwards. Three things break at once:
//
//   - the search index stores RELATIVE paths, so after a move every file on
//     disk looks new and every indexed row looks deleted: the first pass
//     indexes everything AND deletes everything, roughly double a clean start
//   - conversation records point at session files named after the workspace
//     path, so none of them resolve and every lookup scans every project dir
//   - the tracked child-pid file carries process ids from another machine,
//     which are at best meaningless and at worst belong to something else
//
// Rundock should notice and clean up after itself. Users zip folders; any rule
// we publish about what to migrate will be got wrong by someone doing the
// obvious thing.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const h = require('../helpers/harness.js');
const { makeWorkspace, standardTeam } = require('../helpers/workspace.js');

let client;

before(async () => {
  await h.boot();
  client = await h.connect();
});
after(async () => h.shutdown());

function workspaceWithNotes(prefix) {
  const dir = makeWorkspace({ agents: standardTeam(), claudeMd: `# ${prefix}\n` });
  for (let i = 0; i < 5; i++) {
    fs.writeFileSync(path.join(dir, `${prefix}-note-${i}.md`), `# ${prefix} ${i}\n\nToken${prefix}${i} body text.\n`);
  }
  return dir;
}

/** Open a workspace and wait for its index to settle. */
async function open(dir) {
  const since = client.messages.length;
  client.send({ type: 'set_workspace', path: dir });
  await client.waitFor(
    m => m.type === 'system' && m.subtype === 'search_index' && m.state === 'ready' && m.path === dir,
    { since, label: `search index ready for ${path.basename(dir)}` });
}

/** Simulate the zip-and-move: carry .rundock across to a different path. */
function carryStateAcross(fromDir, toDir) {
  fs.cpSync(path.join(fromDir, '.rundock'), path.join(toDir, '.rundock'), { recursive: true });
}

describe('a moved workspace heals its stale state', () => {
  test('the index is rebuilt rather than reconciled against paths that all changed', async () => {
    const origin = workspaceWithNotes('origin');
    await open(origin);

    const moved = workspaceWithNotes('moved');
    carryStateAcross(origin, moved);

    const dbPath = path.join(moved, '.rundock', 'search-index.db');
    const inodeBefore = fs.statSync(dbPath).ino;

    await open(moved);

    // A rebuilt index is a NEW file. A reconciled one is the same file with
    // every row deleted and every row re-inserted, which is strictly more work.
    assert.notStrictEqual(fs.statSync(dbPath).ino, inodeBefore,
      'a workspace opened at a different path must rebuild its index, not reconcile '
      + 'an index whose every path is now wrong');
  });

  test('the moved workspace is still searchable afterwards', async () => {
    const origin = workspaceWithNotes('searchorigin');
    await open(origin);
    const moved = workspaceWithNotes('searchmoved');
    carryStateAcross(origin, moved);
    await open(moved);

    const since = client.messages.length;
    client.send({ type: 'search_universal', query: 'Tokensearchmoved3', reqId: 'moved-1' });
    const { msg } = await client.waitFor(
      m => m.type === 'search_universal_results' && m.reqId === 'moved-1',
      { since, label: 'search results after move' });
    assert.ok(((msg.groups && msg.groups.files) || []).length > 0,
      'healing must leave a correct index, not an empty one');
  });

  test('process ids from the old machine are cleared, not signalled', async () => {
    const origin = workspaceWithNotes('pidorigin');
    await open(origin);

    const moved = workspaceWithNotes('pidmoved');
    carryStateAcross(origin, moved);

    // A live process whose command matches: on a workspace that had NOT moved
    // this is exactly what orphan cleanup signals. After a move the record is
    // meaningless and must be discarded without touching the process.
    const bystander = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e9)'], { stdio: 'ignore' });
    fs.writeFileSync(path.join(moved, '.rundock', 'child-pids.json'),
      JSON.stringify([{ pid: bystander.pid, at: Date.now(), cmd: path.basename(process.execPath) }]));

    try {
      await open(moved);
      await h.delay(150);

      assert.ok(h.pidAlive(bystander.pid),
        'a pid inherited from another machine must never be signalled: it may belong to '
        + 'something else entirely on this one');
      const remaining = JSON.parse(fs.readFileSync(path.join(moved, '.rundock', 'child-pids.json'), 'utf-8'));
      assert.deepStrictEqual(remaining, [], 'and the stale record must be dropped');
    } finally {
      try { bystander.kill('SIGKILL'); } catch (e) {}
    }
  });

  test('conversations and transcripts survive the move', async () => {
    const origin = workspaceWithNotes('convoorigin');
    await open(origin);

    const moved = workspaceWithNotes('convomoved');
    carryStateAcross(origin, moved);

    const convos = [{ id: 'carried-1', title: 'Carried across', agentId: 'chief-of-staff', sessionIds: [] }];
    fs.writeFileSync(path.join(moved, '.rundock', 'conversations.json'), JSON.stringify(convos));
    fs.mkdirSync(path.join(moved, '.rundock', 'transcripts'), { recursive: true });
    fs.writeFileSync(path.join(moved, '.rundock', 'transcripts', 'carried-1.json'),
      JSON.stringify([{ role: 'user', agent: 'user', text: 'still here', timestamp: new Date().toISOString() }]));

    await open(moved);

    const kept = JSON.parse(fs.readFileSync(path.join(moved, '.rundock', 'conversations.json'), 'utf-8'));
    assert.strictEqual(kept.length, 1, 'conversations are real content and must survive a move');
    assert.ok(fs.existsSync(path.join(moved, '.rundock', 'transcripts', 'carried-1.json')),
      'transcripts are self-contained and must survive too');
  });

  test('a workspace that has NOT moved is left completely alone', async () => {
    const stable = workspaceWithNotes('stable');
    await open(stable);

    const dbPath = path.join(stable, '.rundock', 'search-index.db');
    const inodeBefore = fs.statSync(dbPath).ino;

    // Re-opening the same path is a no-op for the engine, so it emits no index
    // status; sequence off the workspace reply instead of waiting for one.
    const since = client.messages.length;
    client.send({ type: 'set_workspace', path: stable });
    await client.waitFor(m => m.type === 'workspace_set', { since, label: 're-open reply' });
    await h.delay(200);

    assert.strictEqual(fs.statSync(dbPath).ino, inodeBefore,
      're-opening the same workspace must not rebuild the index: healing runs once, '
      + 'on a genuine move, not on every open');
  });
});
