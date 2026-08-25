'use strict';
// Integration: the file tree must not be re-walked when nothing has changed.
//
// getFileTree is fully synchronous recursion over the whole workspace, and it
// reads the first kilobyte of every markdown file to classify it. Nothing
// caches the tree payload: the 2-second cache that exists serves only the
// flattened list used by search.
//
// The client asks for the tree far more often than "on open": after every
// file-writing tool call and after every agent turn. Because the server runs
// inside the Electron main process, each of those walks blocks the thread
// driving the window, so on a large vault this presents as the app freezing
// during agent work. Reported by a beta user as hangs that worsened the
// longer the app stayed open.
//
// Observability note: these tests count readdirSync calls under the workspace
// rather than adding a counter to production code. A real walk reads every
// directory; a cache hit should read none. Validating that nothing changed is
// expected to use directory stats, not directory reads, which is what makes
// this a fair measure rather than an implementation detail.
//
// What the count must EXCLUDE, and why the exclusion loses nothing. The count
// used to cover every directory under the workspace, dotfolders included, and
// the server reads two of those on fixed intervals of its own: the
// agents-directory poller reads `.claude/agents` every 2s, and the run-record
// reader reads under `.rundock`. Neither has anything to do with the tree, but
// either one landing inside a measurement window put a 1 where the assertion
// demanded a 0. On an idle machine the window is under a millisecond, so it
// effectively never happened; under contention the window stretches until a
// 2s tick lands in it, which is the whole shape of this failure.
//
// Excluding dotfolders costs no coverage, because getFileTree filters
// `!item.name.startsWith('.')` before it recurses: the walk this file measures
// CANNOT read a dotfolder, so a read under one is never the walk. The sibling
// suite test/integration/external-tree-changes.test.js counts the same way for
// the same reason.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const h = require('../helpers/harness.js');

let client;
let counting = false;
let dirReads = 0;
const realReaddirSync = fs.readdirSync;

/**
 * Is this a directory read the tree walk could have made?
 *
 * Inside the workspace, and outside every dotfolder, because getFileTree
 * refuses to descend into a name beginning with a dot. Anything read below one
 * belongs to something else in the server, and counting it would attribute
 * another component's fixed-interval work to this request.
 */
function isTreeWalkRead(p) {
  if (!p.startsWith(h.workspaceDir)) return false;
  const rel = path.relative(h.workspaceDir, p);
  return !rel.split(path.sep).some(seg => seg.startsWith('.'));
}

before(async () => {
  await h.boot();
  client = await h.connect();
  // Count only reads under the test workspace, only while a measurement is
  // armed, and never inside a dotfolder, so neither unrelated discovery work
  // nor the server's own interval pollers can inflate the numbers. See the
  // header for why the dotfolder exclusion costs no coverage.
  fs.readdirSync = function (p, ...rest) {
    if (counting && isTreeWalkRead(String(p))) dirReads++;
    return realReaddirSync.call(fs, p, ...rest);
  };
});

after(async () => {
  fs.readdirSync = realReaddirSync;
  await h.shutdown();
});

/** Request the tree and return { tree, dirReads } for that request alone. */
async function requestTree() {
  const since = client.messages.length;
  dirReads = 0;
  counting = true;
  client.send({ type: 'get_files' });
  const { msg } = await client.waitFor(m => m.type === 'file_tree', { since, label: 'file_tree' });
  counting = false;
  return { tree: msg.tree, dirReads };
}

function flatten(nodes, out = []) {
  for (const n of nodes || []) {
    out.push(n.path);
    if (n.children) flatten(n.children, out);
  }
  return out;
}

describe('file tree caching', () => {
  test('an unchanged workspace is not re-walked on every request', async () => {
    const first = await requestTree();
    assert.ok(first.dirReads > 0, 'precondition: the first request walks the tree');

    const second = await requestTree();
    assert.strictEqual(second.dirReads, 0,
      `a second request with no filesystem change must not re-walk the tree. `
      + `Expected 0 directory reads, got ${second.dirReads}. This walk runs on the `
      + `Electron main thread and blocks the UI.`);

    assert.deepStrictEqual(flatten(second.tree), flatten(first.tree),
      'the cached payload must match the freshly walked one');
  });

  test('a file created outside Rundock still appears', async () => {
    await requestTree();

    const created = path.join(h.workspaceDir, 'cache-probe-note.md');
    fs.writeFileSync(created, '# Created behind the server\n');

    try {
      const after = await requestTree();
      assert.ok(flatten(after.tree).includes('cache-probe-note.md'),
        'a file created outside Rundock must appear on the next request; '
        + `tree contained: ${flatten(after.tree).slice(0, 12).join(', ')}`);
    } finally {
      try { fs.unlinkSync(created); } catch (e) {}
    }
  });

  test('a file deleted outside Rundock disappears', async () => {
    const created = path.join(h.workspaceDir, 'cache-probe-doomed.md');
    fs.writeFileSync(created, '# Doomed\n');
    await requestTree();

    fs.unlinkSync(created);

    const after = await requestTree();
    assert.ok(!flatten(after.tree).includes('cache-probe-doomed.md'),
      'a file deleted outside Rundock must disappear on the next request');
  });

  test('editing file CONTENTS does not force a re-walk', async () => {
    // The common case during agent work: a file is written, but the tree
    // STRUCTURE is unchanged. This is the case that must stay cheap, because
    // it is the one the client triggers after every file-writing tool call.
    const target = path.join(h.workspaceDir, 'cache-probe-edited.md');
    fs.writeFileSync(target, '# First\n');
    await requestTree();

    fs.writeFileSync(target, '# Second, longer body but same tree shape\n');

    try {
      const after = await requestTree();
      assert.strictEqual(after.dirReads, 0,
        `a content-only edit leaves the tree structure unchanged, so it must not `
        + `trigger a re-walk. Expected 0 directory reads, got ${after.dirReads}.`);
    } finally {
      try { fs.unlinkSync(target); } catch (e) {}
    }
  });
});
