'use strict';
// Integration: the file tree must notice a change made outside Rundock.
//
// The client asks for the tree in exactly three places and all three mean
// "Rundock did something": workspace open, after a file-writing tool call,
// and after an agent turn. The server only ever sends `file_tree` in reply to
// a request, so a file written by an external process (a CLI agent session,
// Obsidian, git, a sync client) never reaches the sidebar until a restart.
// Search does not have this problem: it runs its own TTL-gated reconcile.
//
// These tests drive the change from OUTSIDE the server's own code paths,
// with plain fs writes into the workspace directory, because a write made
// through a handler is exactly the case that already worked.
//
// HONESTY NOTE ON WHAT EACH TEST PROVES, measured by reverting rather than
// assumed. THREE tests go red when the poll is removed, and they are the ones
// that prove the mechanism exists: external create, external mkdir, external
// delete. The remaining tests are guard criteria of the form "and it must not
// also do X" (the two quiet cases, the in-app create, the in-app save, and
// the workspace switch), so with no poller at all they pass vacuously. They
// earn their place once the poller is in, where they are the only thing
// standing between a working push and one that fights the reconcile diff or
// duplicates work Rundock did itself.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const h = require('../helpers/harness.js');

// Short enough that the suite is not dominated by real sleeping, long enough
// that a loaded machine still completes a stat pass inside one interval.
const POLL_MS = 120;
// A push is allowed up to one full interval of latency, plus the walk. Four
// intervals is a generous ceiling that still fails fast when nothing polls.
const PUSH_WINDOW_MS = POLL_MS * 4;

let client;

// Counting directory READS is how the tree cache's own test measures whether
// a pass was cheap, and it is the fair measure here too: validating that
// nothing changed is meant to cost one stat per directory and read none of
// them. Counted only while armed, and never under `.claude`, because the
// agents-directory poller reads there on its own fixed 2s interval and the
// tree walk skips dotfolders entirely.
let counting = false;
let dirReads = 0;
const realReaddirSync = fs.readdirSync;

before(async () => {
  await h.boot({ env: { RUNDOCK_TREE_POLL_MS: String(POLL_MS) } });
  client = await h.connect();
  const dotClaude = path.join(h.workspaceDir, '.claude');
  fs.readdirSync = function (p, ...rest) {
    const s = String(p);
    if (counting && s.startsWith(h.workspaceDir) && !s.startsWith(dotClaude)) dirReads++;
    return realReaddirSync.call(fs, p, ...rest);
  };
  // Boot scaffolds a workspace, which bumps directory mtimes. Let that drain
  // so a quiet-case assertion is not measuring the server's own start-up.
  await h.delay(PUSH_WINDOW_MS);
});

after(async () => {
  fs.readdirSync = realReaddirSync;
  await h.shutdown();
});

/** Every path in a tree payload, folders and files alike. */
function treePaths(nodes, out = []) {
  for (const n of nodes || []) {
    out.push(n.path);
    if (n.children) treePaths(n.children, out);
  }
  return out;
}

/** Only the file nodes in a tree payload, never the folders. */
function treeFiles(nodes, out = []) {
  for (const n of nodes || []) {
    if (n.type === 'folder') treeFiles(n.children, out);
    else out.push(n.path);
  }
  return out;
}

/** file_tree messages that arrived after `since`. */
function pushesSince(since) {
  return client.messages.slice(since).filter(m => m.type === 'file_tree');
}

describe('a change made outside Rundock reaches the file tree', () => {
  test('a file created by another process is pushed without any request', async () => {
    const since = client.messages.length;
    fs.writeFileSync(
      path.join(h.workspaceDir, 'written-by-something-else.md'),
      '# Not created through Rundock\n'
    );

    const { msg } = await client.waitFor(m => m.type === 'file_tree', {
      since,
      timeout: PUSH_WINDOW_MS + 2000,
      label: 'unrequested file_tree push after an external write',
    });

    assert.ok(
      treePaths(msg.tree).includes('written-by-something-else.md'),
      'the pushed tree must contain the externally created file'
    );
  });

  test('a directory created by another process is pushed too', async () => {
    const since = client.messages.length;
    fs.mkdirSync(path.join(h.workspaceDir, 'external-folder'), { recursive: true });
    fs.writeFileSync(
      path.join(h.workspaceDir, 'external-folder', 'nested.md'),
      '# Nested\n'
    );

    const { msg } = await client.waitFor(m => m.type === 'file_tree', {
      since,
      timeout: PUSH_WINDOW_MS + 2000,
      label: 'unrequested file_tree push after an external mkdir',
    });

    const paths = treePaths(msg.tree);
    assert.ok(paths.includes('external-folder'), 'the new folder must be in the pushed tree');
    assert.ok(
      paths.includes('external-folder/nested.md'),
      'the file inside the new folder must be in the pushed tree'
    );
  });

  test('a file deleted by another process is pushed', async () => {
    const target = path.join(h.workspaceDir, 'to-be-deleted.md');
    fs.writeFileSync(target, '# Temporary\n');
    await client.waitFor(m => m.type === 'file_tree' && treePaths(m.tree).includes('to-be-deleted.md'), {
      since: client.messages.length,
      timeout: PUSH_WINDOW_MS + 2000,
      label: 'file_tree containing the file about to be deleted',
    });

    const since = client.messages.length;
    fs.unlinkSync(target);

    const { msg } = await client.waitFor(m => m.type === 'file_tree', {
      since,
      timeout: PUSH_WINDOW_MS + 2000,
      label: 'unrequested file_tree push after an external delete',
    });
    assert.ok(
      !treePaths(msg.tree).includes('to-be-deleted.md'),
      'the deleted file must be gone from the pushed tree'
    );
  });

  test('an untouched workspace produces no pushes at all', async () => {
    // Not "a push that reconciles to zero operations": nothing on the wire.
    const since = client.messages.length;
    await h.delay(POLL_MS * 6);
    const pushes = pushesSince(since);
    assert.strictEqual(
      pushes.length, 0,
      `a quiet workspace must produce zero file_tree pushes, saw ${pushes.length}`
    );
  });

  test('a file created through Rundock does not also produce a poll-driven push', async () => {
    // WHAT DISCRIMINATES THIS TEST, checked by deleting each guard in turn:
    // the freshness check, not the signature check. handleCreatePath rebuilds
    // the cache on its way out, so the next tick finds it fresh and returns
    // before the signature is ever compared. The signature guard is proven by
    // the save test below, which is the path that invalidates without sending.
    const since = client.messages.length;
    client.send({ type: 'create_path', path: 'made-in-rundock.md', kind: 'note', content: '# In app\n' });

    await client.waitFor(m => m.type === 'path_created', {
      since,
      timeout: 4000,
      label: 'path_created for the in-app create',
    });
    await h.delay(POLL_MS * 6);

    const pushes = pushesSince(since);
    assert.strictEqual(
      pushes.length, 1,
      `an in-app create must produce exactly one file_tree, saw ${pushes.length}`
    );
    assert.ok(
      treePaths(pushes[0].tree).includes('made-in-rundock.md'),
      'the single tree must contain the newly created file'
    );
  });

  test('a file saved through Rundock produces no push, because the tree did not change', async () => {
    // A content save invalidates the tree cache but changes no directory
    // mtime and no node. Nothing should reach the sidebar.
    //
    // This is the load-bearing test of the two guards. It goes red when the
    // signature check is deleted (the invalidation alone then reads as an
    // external change), and red again when the handlers stop recording what
    // they sent (the poll then re-sends a tree a handler already delivered).
    // Both were verified by deleting those blocks by hand.
    const since = client.messages.length;
    client.send({ type: 'save_file', path: 'made-in-rundock.md', content: '# In app, edited\n' });

    await client.waitFor(m => m.type === 'file_saved', {
      since,
      timeout: 4000,
      label: 'file_saved for the in-app save',
    });
    await h.delay(POLL_MS * 6);

    const pushes = pushesSince(since);
    assert.strictEqual(
      pushes.length, 0,
      `a content save must produce zero file_tree pushes, saw ${pushes.length}`
    );
  });

  test('polling a quiet workspace reads no directories at all', async () => {
    // The other quiet-case test proves nothing is SENT. It passes just as
    // happily when every tick re-walks the workspace and discards the result,
    // which on a large vault is the whole cost the cache exists to avoid,
    // paid on a timer forever. This one holds the poll to the cached path.
    //
    // WHAT IT DOES NOT PROVE, checked rather than assumed: it does not hold
    // the poll's own `treeCacheIsFresh` short-circuit in place. Deleting that
    // line leaves this assertion green, because getFileTreeCached performs
    // the same check internally and still reads nothing. What that line
    // actually saves is serialising the tree on every idle tick, and no test
    // here discriminates it. The argument for keeping it is written where it
    // lives, in server.js, not smuggled in as a passing test.
    dirReads = 0;
    counting = true;
    await h.delay(POLL_MS * 6);
    counting = false;

    assert.strictEqual(
      dirReads, 0,
      `an idle poll must read no directories, saw ${dirReads} read(s)`
    );
  });

  // LAST ON PURPOSE: this repoints the server at another directory, so any
  // test after it would be measuring a workspace it did not set up.
  test('opening a workspace does not leave the poll believing it missed a change', async () => {
    // Opening a workspace scaffolds into it, which changes the tree AFTER the
    // watcher has taken its baseline. If the tree that open sends is not
    // recorded as sent, the baseline still describes the pre-scaffold
    // directory, and the next cache invalidation that changes nothing
    // structural (a content save) makes the poll compare against it and
    // announce Rundock's own scaffolding as an external change.
    const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'rundock-open-'));
    const since = client.messages.length;
    client.send({ type: 'set_workspace', path: fresh });

    await client.waitFor(m => m.type === 'workspace_set', {
      since,
      timeout: 15000,
      label: 'workspace_set for the freshly opened workspace',
    });
    const opened = await client.waitFor(m => m.type === 'file_tree', {
      since,
      timeout: 15000,
      label: 'file_tree for the freshly opened workspace',
    });

    // Let the scaffold settle, then invalidate WITHOUT sending a tree. It has
    // to be a content save: create_path rebuilds and records on its way out,
    // which repairs a stale baseline and hides exactly the defect under test.
    await h.delay(POLL_MS * 4);

    const scaffolded = treeFiles(opened.msg.tree);
    assert.ok(scaffolded.length > 0, 'opening a workspace must scaffold at least one visible file to save');

    const quiet = client.messages.length;
    client.send({ type: 'save_file', path: scaffolded[0], content: '# Edited after open\n' });
    await client.waitFor(m => m.type === 'file_saved', {
      since: quiet,
      timeout: 8000,
      label: 'file_saved in the freshly opened workspace',
    });
    await h.delay(POLL_MS * 6);

    const pushes = pushesSince(quiet);
    assert.strictEqual(
      pushes.length, 0,
      `a content save after a workspace open must produce zero file_tree pushes, saw ${pushes.length}`
    );
  });
});
