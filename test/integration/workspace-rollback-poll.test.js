'use strict';
// Integration: a workspace switch that fails puts the file-tree poll back.
//
// WHY THIS FILE EXISTS. When opening a workspace throws, handleSetWorkspace
// rolls the root back and re-arms the file-tree poll, and the comment at that
// call site claims the poll then works against the workspace rolled back to.
// The only test covering it stubbed armFileTreeWatcher to a counter, which
// proves the call site is reached and nothing whatever about whether polling
// still works. The belief was the thing under test, so the test reproduced it.
//
// So nothing here is stubbed. The server is the real one, the failure is a
// real filesystem error raised inside the open path, and the detection is a
// real external write observed on the wire.
//
// HOW THE FAILURE IS PRODUCED, and why it has to be this one. The pre-flight
// guard refuses a `.rundock` that is not a directory BEFORE openWorkspace is
// called, so it cannot be the trigger: nothing has been armed at that point
// and there is nothing to roll back. The trigger has to throw INSIDE the open
// path and after arming has baselined against the about-to-fail directory.
// A `.rundock/state.json` that is a directory does exactly that: every read of
// it is caught and yields an empty state, so the open path decides the
// workspace mode is unset and writes it, and that write raises EISDIR with
// nothing above it to catch. A directory where a file belongs is what a
// half-finished restore or a confused sync client leaves behind.
//
// WHAT DISCRIMINATES THE RE-ARM, checked by deleting it rather than assumed.
// The rollback also calls invalidateAgentCache, which cascades into the tree
// cache, so the poll does eventually recover on its own: the tick after the
// rollback rebuilds the tree, finds it differs from the baseline taken in the
// failed workspace, and pushes it. That is why the detection test below is
// NOT the proof of the re-arm. The proof is the quiet test: with the re-arm,
// the rollback re-baselines against the surviving workspace and it stays
// silent until something actually changes. Without it, a workspace nobody
// touched announces itself on the next tick. Both are named at the top of
// their own test.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const h = require('../helpers/harness.js');

// Short enough that the suite is not dominated by real sleeping, long enough
// that a loaded machine still completes a stat pass inside one interval.
const POLL_MS = 120;
// A push is allowed up to one full interval of latency, plus the walk.
const PUSH_WINDOW_MS = POLL_MS * 4;

let client;
/** The directory the switch will fail on. */
let poisoned;
/**
 * The message index taken BEFORE the failed switch is sent.
 *
 * WHY IT IS TAKEN HERE AND NOT WHERE IT IS USED. The quiet assertion below is
 * the one that discriminates the re-arm, and without the re-arm the spurious
 * push lands on the next poll tick, uniformly nought to one interval after the
 * rollback. An index captured at the start of that later test opens the window
 * AFTER the event it is measuring, so a tick landing in the gap is recorded in
 * this test's span, which never looks at file_tree, and the quiet test stays
 * green with the guard deleted. A window that starts after the signal is a
 * window the signal escapes through.
 */
let beforeTheFailedSwitch = null;

before(async () => {
  await h.boot({ env: { RUNDOCK_TREE_POLL_MS: String(POLL_MS) } });
  client = await h.connect();
  // Boot scaffolds the workspace, which bumps directory mtimes. Let that
  // drain so a quiet assertion is not measuring the server's own start-up.
  await h.delay(PUSH_WINDOW_MS);
});

after(async () => {
  await h.shutdown();
  // The suite made this directory, so the suite removes it. The mutation
  // harness runs this file once per guard, so a fixture left behind here is
  // left behind several times per gate run.
  if (poisoned) { try { fs.rmSync(poisoned, { recursive: true, force: true }); } catch (e) { /* best effort */ } }
});

/** Every path in a tree payload, folders and files alike. */
function treePaths(nodes, out = []) {
  for (const n of nodes || []) {
    out.push(n.path);
    if (n.children) treePaths(n.children, out);
  }
  return out;
}

function pushesSince(since) {
  return client.messages.slice(since).filter(m => m.type === 'file_tree');
}

/**
 * A directory that is a real workspace in every way the pre-flight guard can
 * see, and that raises a real error part way through being opened.
 */
function makePoisonedWorkspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rundock-open-fails-'));
  // `.rundock` IS a directory, so the pre-flight guard lets this through and
  // the failure happens inside the open path, which is the case under test.
  fs.mkdirSync(path.join(dir, '.rundock', 'state.json'), { recursive: true });
  return dir;
}

describe('a workspace switch that fails leaves the poll watching the workspace that survived', () => {
  test('the failure is real, and the server says so and stays where it was', async () => {
    poisoned = makePoisonedWorkspace();
    const since = client.messages.length;
    // Shared with the quiet test, which must count from here rather than from
    // its own start. Nothing sends a tree on the failing path: the open throws
    // before it reaches its own file_tree send, and the handler runs to
    // completion in one turn of the message loop, so no tick can interleave.
    // Any file_tree at all from this index onwards is the poll talking.
    beforeTheFailedSwitch = since;
    client.send({ type: 'set_workspace', path: poisoned });

    const { msg } = await client.waitFor(m => m.type === 'workspace_error', {
      since, timeout: 15000, label: 'workspace_error for the switch that could not complete',
    });
    // The message carries the underlying error rather than a synthesised one,
    // which is what says the failure came from the filesystem and not from a
    // branch written to make this test pass.
    assert.match(msg.message, /^Could not open workspace: /);
    assert.match(msg.message, /EISDIR|illegal operation on a directory/i,
      `the open must have failed on the real filesystem error; got: ${msg.message}`);

    assert.strictEqual(h.internal.getWorkspace(), h.workspaceDir,
      'the root must be the workspace that survived, not the one that could not be opened');

    // No workspace_set: a switch that failed must not also look like one that
    // worked.
    assert.deepStrictEqual(
      client.messages.slice(since).filter(m => m.type === 'workspace_set').map(m => m.path),
      [], 'a failed switch must not announce a workspace',
    );
  });

  // THIS is the test the re-arm is proven by, and it goes red when the
  // re-arm is deleted from the rollback path. Arming re-baselines the poll
  // against the workspace that survived; without it the baseline still
  // describes the workspace that failed to open, and the next tick reports the
  // difference as though somebody had changed something.
  test('the workspace that survived is quiet, because the rollback re-baselined the poll', async () => {
    assert.notStrictEqual(beforeTheFailedSwitch, null,
      'the window has to be anchored before the switch, or this proves nothing');
    await h.delay(POLL_MS * 6);
    const pushes = pushesSince(beforeTheFailedSwitch);
    assert.strictEqual(
      pushes.length, 0,
      'nothing was touched, so a rolled-back workspace must produce zero file_tree pushes, saw '
      + `${pushes.length}. A push here means the poll is still baselined against the workspace `
      + 'that failed to open. Counted from before the switch was sent, so a push landing in the '
      + 'moments between the rollback and this test is counted rather than missed.',
    );
  });

  // The property the comment at the call site claims, measured on the
  // wire against a real write by something that is not Rundock.
  test('an external write to the restored workspace is still detected', async () => {
    const since = client.messages.length;
    const wroteAt = Date.now();
    fs.writeFileSync(
      path.join(h.workspaceDir, 'written-after-the-failed-switch.md'),
      '# Not created through Rundock\n',
    );

    const { msg } = await client.waitFor(m => m.type === 'file_tree', {
      since,
      // The generous timeout is a HANG GUARD, not the bound. A test that only
      // waits proves whatever the machine happened to do, so the detection
      // interval is asserted below as a number instead. Left long so a slow
      // runner fails on the bound with a measurement in the message rather
      // than on a timeout with nothing in it.
      timeout: PUSH_WINDOW_MS + 2000,
      label: 'unrequested file_tree push after an external write to the restored workspace',
    });
    const elapsed = Date.now() - wroteAt;
    assert.ok(
      treePaths(msg.tree).includes('written-after-the-failed-switch.md'),
      'the push must describe the workspace rolled back to, not the one that failed to open',
    );
    assert.ok(elapsed <= PUSH_WINDOW_MS,
      `this is the detection bound the test enforces: the push must `
      + `arrive within ${PUSH_WINDOW_MS}ms of the write, which is four poll intervals. It took `
      + `${elapsed}ms. A server ignoring the configured interval and polling on its default `
      + 'would fail here rather than pass on a long timeout.');
  });

  // Cheap, and worth recording. The scheduler's lifecycle now runs on
  // workspace set and unset, so a failed switch stops the ticker for the
  // workspace being left and the rollback has to start one again. A rollback
  // that restored the root and left no scheduler would be a workspace whose
  // routines silently stop firing until the next restart, which is exactly the
  // fault that put the lifecycle in setWorkspaceRoot in the first place.
  test('the scheduler is running, and against the workspace that survived', () => {
    assert.strictEqual(h.internal.schedulerRunning(), true,
      'the rollback goes through setWorkspaceRoot, so the surviving workspace must have a scheduler');
    // THE SECOND HALF, because "a scheduler is running" on its own is a proxy
    // for the property that matters here. A ticker running against the
    // directory that failed to open would satisfy the line above and be
    // exactly the fault. The tick reads the workspace root at tick time, so
    // the root IS the binding, and this is the whole of what was observed.
    assert.strictEqual(h.internal.getWorkspace(), h.workspaceDir,
      'the root a tick will read is the workspace that survived, not the one that failed');
  });

  // A failed switch must not leave the previous workspace's tree poisoned by
  // the one that failed either. Asked of the tree a client requests, which is
  // the other consumer of the same cache.
  test('a requested tree describes the workspace that survived', async () => {
    const since = client.messages.length;
    client.send({ type: 'get_files' });
    const { msg } = await client.waitFor(m => m.type === 'file_tree', {
      since, timeout: 8000, label: 'file_tree in reply to get_files after the failed switch',
    });
    const paths = treePaths(msg.tree);
    assert.ok(paths.includes('written-after-the-failed-switch.md'),
      'the requested tree must be the surviving workspace, complete with what was written to it');
  });
});
