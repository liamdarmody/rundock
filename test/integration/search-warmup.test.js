'use strict';
// Integration: opening a workspace must not freeze the app while the search
// index builds.
//
// The initial index runs on the thread that draws the window. It used to run
// to completion in one go, so on a large workspace the window was painted and
// completely unresponsive until indexing finished: the client's follow-up
// requests for agents, files, skills and conversations all queued behind it.
// A user cannot tell that apart from a crash, and restarting only starts the
// work again.
//
// The assertion is ORDERING, not timing: a request sent right after the
// workspace opens must be answered BEFORE indexing reports itself finished.
// That holds regardless of how fast the machine running the test is.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const h = require('../helpers/harness.js');
const { makeWorkspace, standardTeam } = require('../helpers/workspace.js');
const { RECONCILE_BATCH_FILES } = require('../../search.js');

let client;

before(async () => {
  await h.boot();
  client = await h.connect();
});
after(async () => h.shutdown());

/** A workspace with enough notes that indexing spans several commit batches. */
function makeLargeWorkspace() {
  const dir = makeWorkspace({ agents: standardTeam(), claudeMd: '# Large Workspace\n' });
  const notes = path.join(dir, 'notes');
  fs.mkdirSync(notes, { recursive: true });
  for (let i = 0; i < RECONCILE_BATCH_FILES * 24; i++) {
    fs.writeFileSync(path.join(notes, `note-${i}.md`),
      `# Note ${i}\n\nWarmuptoken${i} plus a paragraph of filler so the file has real content to index.\n`);
  }
  return dir;
}

describe('search index warm-up', () => {
  test('the app answers requests while the index is still building', async () => {
    const dir = makeLargeWorkspace();
    const since = client.messages.length;

    client.send({ type: 'set_workspace', path: dir });
    await client.waitFor(
      m => m.type === 'system' && m.subtype === 'search_index' && m.state === 'indexing',
      { since, label: 'indexing started' });
    // Scan from HERE: set_workspace sends its own agents payload, and matching
    // that instead of the reply to our request would pass by accident.
    const probeSince = client.messages.length;
    // Sent while the pass is genuinely in flight, as the client does on open.
    client.send({ type: 'get_agents' });

    const { index: answered } = await client.waitFor(
      m => m.type === 'agents', { since: probeSince, label: 'agents reply during indexing' });
    const { index: ready } = await client.waitFor(
      m => m.type === 'system' && m.subtype === 'search_index' && m.state === 'ready',
      { since: probeSince, label: 'search_index ready' });

    assert.ok(answered < ready,
      `a request sent while the index is building must be answered before indexing `
      + `finishes. The reply landed at message ${answered} and indexing reported ready `
      + `at ${ready}, so the socket was blocked for the whole pass.`);
  });

  test('indexing announces that it started, so the UI can say so', async () => {
    const dir = makeLargeWorkspace();
    const since = client.messages.length;

    client.send({ type: 'set_workspace', path: dir });

    const { msg } = await client.waitFor(
      m => m.type === 'system' && m.subtype === 'search_index' && m.state === 'indexing',
      { since, label: 'search_index indexing' });
    assert.strictEqual(msg.state, 'indexing');
  });

  test('the index is complete and searchable once it reports ready', async () => {
    const dir = makeLargeWorkspace();
    const since = client.messages.length;

    client.send({ type: 'set_workspace', path: dir });
    await client.waitFor(
      m => m.type === 'system' && m.subtype === 'search_index' && m.state === 'ready',
      { since, label: 'search_index ready' });

    const searchSince = client.messages.length;
    client.send({ type: 'search_universal', query: 'Warmuptoken7', reqId: 'warmup-1' });
    const { msg } = await client.waitFor(
      m => m.type === 'search_universal_results' && m.reqId === 'warmup-1', { since: searchSince, label: 'search results' });
    const files = (msg.groups && msg.groups.files) || [];
    assert.ok(files.length > 0,
      'a file indexed during warm-up must be findable once warm-up reports ready');
  });
});
