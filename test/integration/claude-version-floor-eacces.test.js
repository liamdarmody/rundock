'use strict';
// A COPY THAT CANNOT BE RUN SAYS SO AS IT ALWAYS DID.
//
// The version floor reads a copy's version before starting it. A copy at the
// path Rundock resolved that has lost its execute permission gives no
// version, which lets the spawn go ahead, and the spawn then fails as it
// always did: the conversation shows the permission-denied message, not the
// too-old notice and not the generic one, and the thinking state clears.
//
// Own file, own process: the path resolved here stays resolved for the life
// of the process, so it must not reach another file's tests.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const h = require('../helpers/harness.js');
const { standardTeam, makeTempDir } = require('../helpers/workspace.js');

const PERMISSION_DENIED = "Couldn't start Claude Code: permission denied. Check your install.";
const POSIX = process.platform === 'win32' ? 'a copy that cannot be run is made by taking its execute permission' : false;

let client;

before(async () => {
  await h.boot({ agents: standardTeam() });
  process.env.STUB_CLAUDE_VERSION = '2.0.58';
  client = await h.connect();
});

after(async () => {
  delete process.env.STUB_CLAUDE_VERSION;
  await h.shutdown();
});

const isInfo = (convoId) => (m) => m.type === 'system' && m.subtype === 'info' && m._conversationId === convoId;
const isDone = (convoId) => (m) => m.type === 'system' && m.subtype === 'done' && m._conversationId === convoId;

async function sendAndSettle(convoId) {
  const since = client.messages.length;
  client.send({ type: 'chat', conversationId: convoId, agent: 'chief-of-staff', content: 'hello' });
  const { index } = await client.waitFor(isDone(convoId), { since, label: `done in ${convoId}` });
  return client.messages.slice(since, index + 1);
}

test('a copy at the resolved path that cannot be run fails with the permission-denied message, unchanged', { skip: POSIX }, async () => {
  // The stub, below the floor, is refused and its path let go, so the next
  // spawn finds `claude` again.
  const refused = h.freshConvoId('eaccesold');
  assert.ok((await sendAndSettle(refused)).filter(isInfo(refused)).some((m) => m.content.startsWith('Rundock found Claude Code 2.0.58')));

  const dir = makeTempDir('claude-eacces-');
  const bin = path.join(dir, 'claude');
  fs.writeFileSync(bin, '#!/bin/sh\nexit 0\n');
  fs.chmodSync(bin, 0o755);
  const pathBefore = process.env.PATH;
  const warned = [];
  const realWarn = console.warn;
  try {
    process.env.PATH = dir + path.delimiter + pathBefore;
    assert.strictEqual(h.internal.resolveClaudeBin(), bin, 'found while it could still be run');
    fs.chmodSync(bin, 0o644);
    console.warn = (...args) => { warned.push(args.join(' ')); };
    h.clearInvocations();
    const convoId = h.freshConvoId('eacces');
    const seen = await sendAndSettle(convoId);
    assert.deepStrictEqual(seen.filter(isInfo(convoId)).map((m) => m.content), [PERMISSION_DENIED]);
    assert.ok(seen.some(isDone(convoId)), 'and the thinking state clears');
    assert.strictEqual(warned.filter((line) => line.includes(bin)).length, 1, 'its unknown version logged once');
    assert.deepStrictEqual(h.readInvocations(), []);
  } finally {
    console.warn = realWarn;
    process.env.PATH = pathBefore;
  }
});
