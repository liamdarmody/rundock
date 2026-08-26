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
//
// The WAITS are a different matter, and they are why this file blocked a gate
// five times. makeLargeWorkspace writes 6,000 markdown files and the server
// then indexes all of them, once per test. Measured on an idle machine that
// is 1.5 to 2.2 seconds, against client.waitFor's 8-second default: four-fold
// headroom on the heaviest fixture in the suite, on the assumption that a CI
// disk behaves like a local SSD. When it does not, the run fails as "Timed out
// waiting for search_index ready" and says nothing about the ordering property
// the file exists to prove.
//
// So every wait on the index reaching a state carries an explicit budget
// naming the work it covers. This weakens no assertion: warm-up that genuinely
// never completes still fails the test, it just takes longer to say so.
const INDEX_TIMEOUT_MS = 60000;
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
      m => m.type === 'system' && m.subtype === 'search_index' && m.state === 'indexing' && m.path === dir,
      { since, label: 'indexing started', timeout: INDEX_TIMEOUT_MS });
    // Scan from HERE: set_workspace sends its own agents payload, and matching
    // that instead of the reply to our request would pass by accident.
    const probeSince = client.messages.length;
    // Sent while the pass is genuinely in flight, as the client does on open.
    client.send({ type: 'get_agents' });

    const { index: answered } = await client.waitFor(
      m => m.type === 'agents',
      { since: probeSince, label: 'agents reply during indexing', timeout: INDEX_TIMEOUT_MS });
    const { index: ready } = await client.waitFor(
      m => m.type === 'system' && m.subtype === 'search_index' && m.state === 'ready' && m.path === dir,
      { since: probeSince, label: 'search_index ready', timeout: INDEX_TIMEOUT_MS });

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
      m => m.type === 'system' && m.subtype === 'search_index' && m.state === 'indexing' && m.path === dir,
      { since, label: 'search_index indexing', timeout: INDEX_TIMEOUT_MS });
    assert.strictEqual(msg.state, 'indexing');
  });

  test('the index is complete and searchable once it reports ready', async () => {
    const dir = makeLargeWorkspace();
    const since = client.messages.length;

    client.send({ type: 'set_workspace', path: dir });
    await client.waitFor(
      m => m.type === 'system' && m.subtype === 'search_index' && m.state === 'ready' && m.path === dir,
      { since, label: 'search_index ready', timeout: INDEX_TIMEOUT_MS });

    const searchSince = client.messages.length;
    client.send({ type: 'search_universal', query: 'Warmuptoken7', reqId: 'warmup-1' });
    const { msg } = await client.waitFor(
      m => m.type === 'search_universal_results' && m.reqId === 'warmup-1', { since: searchSince, label: 'search results', timeout: INDEX_TIMEOUT_MS });
    const files = (msg.groups && msg.groups.files) || [];
    assert.ok(files.length > 0,
      'a file indexed during warm-up must be findable once warm-up reports ready');
  });
});
