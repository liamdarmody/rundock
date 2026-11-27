'use strict';
// A TRANSCRIPT SAVES TO THE WORKSPACE ITS CONVERSATION BELONGS TO.
//
// A workspace switch stops the running agent and moves the workspace root in
// one step, but the stopped process's last output is still read afterwards,
// and the row it adds is saved after the root has moved. Saved to whichever
// workspace was open by then, the whole conversation, every earlier message
// included, landed in the workspace just opened. Each case here moves the root
// between the first save and a later one, through the store's own functions,
// as every caller that adds a row does (server.js appendTranscript, the
// compaction entry).
const { test, describe, beforeEach, afterEach, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const config = require('../../lib/config.js');
const { convoTranscripts, loadTranscript, saveTranscript, appendCompaction } = require('../../lib/store/transcripts.js');
const { makeWorkspace, cleanup } = require('../helpers/workspace.js');

after(cleanup);

let first;
let second;
beforeEach(() => {
  first = makeWorkspace({ claudeMd: '# First fixture\n' });
  second = makeWorkspace({ claudeMd: '# Second fixture\n' });
  config.setWorkspace(first);
  convoTranscripts.clear();
});
afterEach(() => config.setWorkspace(null));

const fileIn = (root, id) => path.join(root, '.rundock', 'transcripts', `${id}.json`);
function rowsIn(root, id) {
  assert.ok(fs.existsSync(fileIn(root, id)), 'the conversation has a transcript in that workspace');
  return JSON.parse(fs.readFileSync(fileIn(root, id), 'utf-8'));
}
const row = (text) => ({ role: 'user', agent: 'user', text, timestamp: new Date().toISOString() });

// Every file under a folder with its contents, so "nothing was written" covers
// a file that was changed as well as one that was made.
function tree(dir) {
  const out = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { out[path.relative(dir, p) + '/'] = ''; walk(p); } else out[path.relative(dir, p)] = fs.readFileSync(p, 'utf-8');
    }
  };
  walk(dir);
  return out;
}

describe('a row saved after the workspace moves', () => {
  test('goes to the workspace the conversation was first saved in, and nothing to the one opened', () => {
    convoTranscripts.set('convo-a', [row('first message in alpha')]);
    saveTranscript('convo-a');
    config.setWorkspace(second);
    const before = tree(second);
    loadTranscript('convo-a').push(row('second message in alpha'));
    saveTranscript('convo-a');
    assert.deepStrictEqual(rowsIn(first, 'convo-a').map((t) => t.text), ['first message in alpha', 'second message in alpha']);
    assert.deepStrictEqual(tree(second), before, 'the workspace opened holds nothing new');
  });

  test('writes nothing and makes no folder when the first workspace folder has been removed', () => {
    convoTranscripts.set('convo-b', [row('first message in alpha')]);
    saveTranscript('convo-b');
    config.setWorkspace(second);
    fs.rmSync(first, { recursive: true, force: true });
    const before = tree(second);
    const siblings = fs.readdirSync(path.dirname(first)).sort();
    loadTranscript('convo-b').push(row('second message in alpha'));
    assert.doesNotThrow(() => saveTranscript('convo-b'));
    assert.strictEqual(fs.existsSync(first), false, 'the removed workspace folder is not made again');
    assert.deepStrictEqual(fs.readdirSync(path.dirname(first)).sort(), siblings, 'nothing is made beside it either');
    assert.deepStrictEqual(tree(second), before, 'the workspace opened holds nothing new');
  });

  test('goes to the workspace it was read from, for a transcript loaded from disk', () => {
    convoTranscripts.set('convo-c', [row('first message in alpha')]);
    saveTranscript('convo-c');
    convoTranscripts.clear();
    assert.strictEqual(loadTranscript('convo-c').length, 1, 'read back from the first workspace');
    config.setWorkspace(second);
    loadTranscript('convo-c').push(row('second message in alpha'));
    saveTranscript('convo-c');
    assert.deepStrictEqual(rowsIn(first, 'convo-c').map((t) => t.text), ['first message in alpha', 'second message in alpha']);
    assert.strictEqual(fs.existsSync(fileIn(second, 'convo-c')), false, 'nothing for it in the workspace opened');
  });

  test('makes the .rundock folder in a first workspace that has none yet, and nothing in the one opened', () => {
    // The workspace folder is what has to exist: a workspace that has never
    // saved anything has no .rundock folder, and is still there.
    fs.rmSync(path.join(first, '.rundock'), { recursive: true, force: true });
    assert.strictEqual(loadTranscript('convo-d').length, 0, 'nothing stored for it yet');
    config.setWorkspace(second);
    const before = tree(second);
    loadTranscript('convo-d').push(row('first message in alpha'));
    saveTranscript('convo-d');
    assert.deepStrictEqual(rowsIn(first, 'convo-d').map((t) => t.text), ['first message in alpha']);
    assert.deepStrictEqual(tree(second), before, 'the workspace opened holds nothing new');
  });
});

describe('a summary marked after the workspace moves', () => {
  test('is stored with its conversation in the first workspace, and nothing in the one opened', () => {
    assert.strictEqual(appendCompaction('convo-e', 'summary-1'), true);
    config.setWorkspace(second);
    const before = tree(second);
    appendCompaction('convo-e', 'summary-2');
    assert.deepStrictEqual(rowsIn(first, 'convo-e').map((t) => t.key), ['summary-1', 'summary-2']);
    assert.deepStrictEqual(tree(second), before, 'the workspace opened holds nothing new');
  });

  test('writes nothing and makes no folder for the summary when the first workspace folder has been removed', () => {
    appendCompaction('convo-f', 'summary-1');
    config.setWorkspace(second);
    fs.rmSync(first, { recursive: true, force: true });
    const before = tree(second);
    const siblings = fs.readdirSync(path.dirname(first)).sort();
    assert.doesNotThrow(() => appendCompaction('convo-f', 'summary-2'));
    assert.strictEqual(fs.existsSync(first), false, 'the removed workspace folder is not made again');
    assert.deepStrictEqual(fs.readdirSync(path.dirname(first)).sort(), siblings, 'nothing is made beside it either');
    assert.deepStrictEqual(tree(second), before, 'the workspace opened holds nothing new');
  });
});
