// The tree walk must not open files whose identity has not changed.
//
// Classifying a markdown file for its tree icon reads its frontmatter head,
// which means opening the file. On a cloud-synced vault (iCloud, OneDrive,
// Dropbox with online-only files) an open can force the provider to download
// the file's content; a tree rebuild that opens every note turns into a
// freeze that scales with vault size. A stat does not materialise content,
// so the fix is an identity check: only a file whose mtime or size moved is
// worth opening again.
//
// These tests count actual opens during walks by spying on fs.openSync,
// which the head-read uses. The invariant: a walk over unchanged files opens
// nothing, and a walk after one change opens exactly that one file.

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { _internal } = require('../../server.js');

const NOTE_COUNT = 24;

let dir;
let realOpenSync;
let openCount;

function countingOpenSync(...args) {
  openCount += 1;
  return realOpenSync.apply(fs, args);
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rundock-kind-cache-'));
  for (let i = 0; i < NOTE_COUNT; i++) {
    const body = i % 5 === 0
      ? '---\nkanban-plugin: board\n---\n\n## Doing\n'
      : `# Note ${i}\n\nBody.\n`;
    fs.writeFileSync(path.join(dir, `note-${String(i).padStart(2, '0')}.md`), body);
  }
  realOpenSync = fs.openSync;
  openCount = 0;
});

afterEach(() => {
  fs.openSync = realOpenSync;
  fs.rmSync(dir, { recursive: true, force: true });
});

function walkCountingOpens() {
  openCount = 0;
  fs.openSync = countingOpenSync;
  try {
    return _internal.getFileTree(dir);
  } finally {
    fs.openSync = realOpenSync;
  }
}

describe('file opens during a tree walk', () => {
  test('a walk over unchanged files opens none of them', () => {
    walkCountingOpens(); // cold: entitled to open everything once
    const warmOpens = (walkCountingOpens(), openCount);
    assert.strictEqual(
      warmOpens, 0,
      `expected an unchanged walk to open no files, but it opened ${warmOpens} of ${NOTE_COUNT}: the cost scales with note count`
    );
  });

  test('after one file changes, only that file is opened', () => {
    walkCountingOpens();
    const changed = path.join(dir, 'note-03.md');
    fs.writeFileSync(changed, '# Note 3, edited\n\nNew body.\n');
    // File timestamps can be coarse; force a distinct mtime so the change
    // is visible to an identity check regardless of filesystem granularity.
    const future = new Date(Date.now() + 5000);
    fs.utimesSync(changed, future, future);
    walkCountingOpens();
    assert.strictEqual(openCount, 1, `expected exactly 1 open after 1 change, got ${openCount}`);
  });

  test('classification stays correct through the cache', () => {
    const tree1 = walkCountingOpens();
    const kinds1 = Object.fromEntries(tree1.map((n) => [n.name, n.kind]));
    assert.strictEqual(kinds1['note-00.md'], 'board');
    assert.strictEqual(kinds1['note-01.md'], 'note');

    // Turning a note into a board must be picked up once its identity moves.
    const target = path.join(dir, 'note-01.md');
    fs.writeFileSync(target, '---\nkanban-plugin: board\n---\n\n## Doing\n');
    const future = new Date(Date.now() + 5000);
    fs.utimesSync(target, future, future);
    const tree2 = walkCountingOpens();
    const kinds2 = Object.fromEntries(tree2.map((n) => [n.name, n.kind]));
    assert.strictEqual(kinds2['note-01.md'], 'board');
  });
});
