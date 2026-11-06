'use strict';
// THE SETTINGS PROBE READS A VERSION WITH NO SHELL.
//
// It used to build `"<path>" --version` as a command line and hand it to a
// shell, so a `$(...)` in the folder Claude Code was found in ran as a command
// of its own. It now asks the copy the lookup found with arguments, and the
// folder is only ever a path.
//
// Own file, own process: the copy the server starts is kept for the process,
// so the case first lets it go the way a person would, with a message the
// floor refuses, and then puts a copy in an odd folder first on the PATH.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const h = require('../helpers/harness.js');
const { makeTempDir } = require('../helpers/workspace.js');
const { makeClaude, CURRENT } = require('../helpers/login-shell.js');

const POSIX = process.platform === 'win32' ? 'the stub is a POSIX script' : false;

let client;
before(async () => { await h.boot(); client = await h.connect(); });
after(async () => {
  delete process.env.STUB_CLAUDE_VERSION;
  delete process.env.SETTINGS_SHELL_MARKER;
  await h.shutdown();
});

const isDone = (convoId) => (m) => m.type === 'system' && m.subtype === 'done' && m._conversationId === convoId;

test('a copy found in a folder holding $(...) is asked for its version, and nothing in the folder name runs', { skip: POSIX }, async () => {
  const root = makeTempDir('probe-no-shell-');
  const marker = path.join(root, 'ran-in-a-shell');
  process.env.SETTINGS_SHELL_MARKER = marker;

  // The copy the server kept is let go: a message on a copy below the floor.
  process.env.STUB_CLAUDE_VERSION = '2.0.58';
  const convoId = h.freshConvoId('probe');
  let since = client.messages.length;
  client.send({ type: 'chat', conversationId: convoId, agent: 'chief-of-staff', content: 'hello' });
  await client.waitFor(isDone(convoId), { since, label: 'the refused message' });
  delete process.env.STUB_CLAUDE_VERSION;

  const odd = makeClaude(path.join(root, 'q$(touch $SETTINGS_SHELL_MARKER)'), CURRENT);
  const before = process.env.PATH;
  process.env.PATH = odd.dir + path.delimiter + before;
  try {
    since = client.messages.length;
    client.send({ type: 'get_runtime_status' });
    const { msg } = await client.waitFor((m) => m.type === 'runtime_status', { since, label: 'runtime_status' });
    assert.strictEqual(fs.existsSync(marker), false, 'nothing in the folder name was run');
    assert.strictEqual(msg.claude.installed, true);
    assert.strictEqual(msg.claude.version, '2.1.318', 'the version of the copy in the odd folder, read as a path');
    assert.deepStrictEqual(odd.probes().map((r) => r.args), [['--version']], 'asked once, with arguments');
  } finally {
    process.env.PATH = before;
  }
});
