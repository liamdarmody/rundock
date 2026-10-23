'use strict';
// create_path never writes over anything already at the path it was given.
//
// A note is created by a click on a link to a missing one, with no prompt, so
// "already there" has to be decided by the write itself, not by a check made
// a moment before it. Three ways a check-then-write goes wrong, each driven
// against the real server:
//   - a dangling link at the path, pointing outside the workspace: a check
//     that follows the link sees nothing there, and a write that follows it
//     lands outside;
//   - a name spelled with a decomposed accent, where the file system may hold
//     the composed spelling as the same file;
//   - another writer creating the file between the check and the write.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const h = require('../helpers/harness.js');
const { makeTempDir } = require('../helpers/workspace.js');

let client;

function create(rel, content) {
  const since = client.messages.length;
  client.send({ type: 'create_path', path: rel, kind: 'note', content });
  return client.waitFor((m) => (m.type === 'path_created' || m.type === 'create_error') && m.path === rel,
    { since, label: `the answer for ${rel}` }).then((r) => r.msg);
}

before(async () => {
  await h.boot();
  client = await h.connect();
});
after(async () => h.shutdown());

describe('create_path is an exclusive create', () => {
  test('a dangling link at the path is not followed out of the workspace', async () => {
    const outside = makeTempDir('outside-');
    const landing = path.join(outside, 'escaped.md');
    fs.symlinkSync(landing, path.join(h.workspaceDir, 'dangling.md'));
    const answer = await create('dangling.md', 'written through the link');
    assert.strictEqual(answer.type, 'create_error');
    assert.strictEqual(answer.reason, 'already exists');
    assert.ok(!fs.existsSync(landing), 'nothing was written outside the workspace');
  });

  test('a decomposed spelling of an existing note never empties it', async () => {
    const composed = 'Café.md';
    const decomposed = 'Café.md';
    fs.writeFileSync(path.join(h.workspaceDir, composed), 'the existing note');
    // Whether the two spellings are one file is the file system's to say.
    const sameFile = fs.existsSync(path.join(h.workspaceDir, decomposed));
    const answer = await create(decomposed, '');
    assert.strictEqual(fs.readFileSync(path.join(h.workspaceDir, composed), 'utf-8'), 'the existing note');
    assert.strictEqual(answer.type, sameFile ? 'create_error' : 'path_created');
    if (sameFile) assert.strictEqual(answer.reason, 'already exists');
  });

  test('a file another writer makes after any check is not overwritten', async () => {
    const rel = 'raced.md';
    const full = path.join(h.workspaceDir, rel);
    fs.writeFileSync(full, 'written by someone else');
    // Every look before the write says the path is free, as it did for a
    // check made just before the other writer got there.
    const realExists = fs.existsSync;
    fs.existsSync = (p) => (path.resolve(String(p)) === full ? false : realExists(p));
    let answer;
    try { answer = await create(rel, ''); } finally { fs.existsSync = realExists; }
    assert.strictEqual(answer.type, 'create_error');
    assert.strictEqual(answer.reason, 'already exists');
    assert.strictEqual(fs.readFileSync(full, 'utf-8'), 'written by someone else');
  });

  test('a free path is still created, with its folder', async () => {
    const answer = await create('fresh/made.md', '# Made\n');
    assert.strictEqual(answer.type, 'path_created');
    assert.strictEqual(fs.readFileSync(path.join(h.workspaceDir, 'fresh', 'made.md'), 'utf-8'), '# Made\n');
  });
});
