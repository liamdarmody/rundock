'use strict';
// Integration: loading the conversation list must cost what has CHANGED, not
// what is held.
//
// get_conversations enriches every conversation on every call, and it fires on
// workspace open and on every client reconnect, including whenever a laptop
// wakes and the socket comes back. For each conversation it read and parsed
// every session file that conversation ever touched, to count message bubbles.
// Nothing was cached.
//
// It also resolved each session through the UNCACHED lookup, while a memoising
// resolver with negative-result caching sat beside it. The expected location is
// derived from the workspace path, so on a workspace that has been moved every
// lookup misses, and each miss lists the projects directory and stats every
// entry in it. A user reporting hangs has 364 conversations, which is close to
// a thousand such lookups per reconnect.
//
// The harness points HOME at a temp directory, so the project directories these
// tests create are real from the server's point of view and entirely disposable.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const h = require('../helpers/harness.js');

let client;
let projectsDir;

// Filesystem counters, armed only around the call under test so unrelated work
// cannot inflate them.
let counting = false;
let dirScans = 0;
let sessionReads = 0;
const realReaddirSync = fs.readdirSync;
const realReadFileSync = fs.readFileSync;

before(async () => {
  await h.boot();
  client = await h.connect();
  projectsDir = path.join(process.env.HOME, '.claude', 'projects');
  fs.mkdirSync(projectsDir, { recursive: true });
  // Several unrelated project directories: these are what a failed lookup
  // walks, once per miss.
  for (let i = 0; i < 12; i++) {
    fs.mkdirSync(path.join(projectsDir, `-Users-someone-project-${i}`), { recursive: true });
  }

  fs.readdirSync = function (p, ...rest) {
    if (counting && String(p) === projectsDir) dirScans++;
    return realReaddirSync.call(fs, p, ...rest);
  };
  fs.readFileSync = function (p, ...rest) {
    if (counting && String(p).endsWith('.jsonl')) sessionReads++;
    return realReadFileSync.call(fs, p, ...rest);
  };
});

after(async () => {
  fs.readdirSync = realReaddirSync;
  fs.readFileSync = realReadFileSync;
  await h.shutdown();
});

function jsonlTurns(n) {
  const lines = [];
  for (let i = 0; i < n; i++) {
    lines.push(JSON.stringify({ type: 'user', message: { role: 'user', content: `question ${i}` } }));
    lines.push(JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: `answer ${i}` }] } }));
  }
  return lines.join('\n') + '\n';
}

/** Write a session file where the server expects it for this workspace. */
function writeSession(sessionId, turns) {
  const hash = h.workspaceDir.replace(/\//g, '-');
  const dir = path.join(projectsDir, hash);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${sessionId}.jsonl`);
  fs.writeFileSync(file, jsonlTurns(turns));
  return file;
}

function seedConversations(convos) {
  // Survive the empty-conversation prune: it keeps anything with a legacy
  // sessionId or a recent timestamp, and drops the rest before enrichment.
  const stamped = convos.map(c => ({ createdAt: new Date().toISOString(), lastActiveAt: new Date().toISOString(), ...c }));
  convos = stamped;
  fs.writeFileSync(path.join(h.workspaceDir, '.rundock', 'conversations.json'), JSON.stringify(convos));
}

/** Request the list and report what it cost on the filesystem. */
async function loadConversations() {
  const since = client.messages.length;
  dirScans = 0; sessionReads = 0; counting = true;
  client.send({ type: 'get_conversations' });
  const { msg } = await client.waitFor(m => m.type === 'conversations', { since, label: 'conversations' });
  counting = false;
  return { msg, dirScans, sessionReads };
}

describe('conversation list enrichment', () => {
  test('an unchanged session is not re-read on every load', async () => {
    writeSession('sess-unchanged', 4);
    seedConversations([{
      id: 'c-unchanged', title: 'Unchanged', agentId: 'chief-of-staff',
      sessionIds: [{ sessionId: 'sess-unchanged', agentId: 'chief-of-staff' }],
    }]);

    const first = await loadConversations();
    assert.ok(first.sessionReads > 0, 'precondition: the first load reads the session');

    const second = await loadConversations();
    assert.strictEqual(second.sessionReads, 0,
      `nothing changed between loads, so no session file should be read again. `
      + `The second load re-read ${second.sessionReads} file(s). This runs on every `
      + `reconnect, so the cost is paid every time a laptop wakes.`);
  });

  test('a session that cannot resolve is not re-scanned across project directories', async () => {
    seedConversations([
      { id: 'c-missing-1', title: 'Missing 1', agentId: 'chief-of-staff', sessionIds: [{ sessionId: 'nowhere-1', agentId: 'chief-of-staff' }] },
      { id: 'c-missing-2', title: 'Missing 2', agentId: 'chief-of-staff', sessionIds: [{ sessionId: 'nowhere-2', agentId: 'chief-of-staff' }] },
      { id: 'c-missing-3', title: 'Missing 3', agentId: 'chief-of-staff', sessionIds: [{ sessionId: 'nowhere-3', agentId: 'chief-of-staff' }] },
    ]);

    await loadConversations();
    const second = await loadConversations();

    assert.strictEqual(second.dirScans, 0,
      `a session id already known to resolve nowhere must not send us walking every `
      + `project directory again. The second load scanned ${second.dirScans} time(s). `
      + `After a workspace move EVERY session misses, so this multiplies by the number `
      + `of conversations held.`);
  });

  test('a session that HAS changed is re-counted, so counts stay correct', async () => {
    const file = writeSession('sess-growing', 2);
    seedConversations([{
      id: 'c-growing', title: 'Growing', agentId: 'chief-of-staff',
      sessionIds: [{ sessionId: 'sess-growing', agentId: 'chief-of-staff' }],
    }]);

    const first = await loadConversations();
    const countBefore = (first.msg.conversations.find(c => c.id === 'c-growing') || {}).messageCount;
    assert.ok(countBefore > 0, 'precondition: the first load counts messages');

    // Append turns, as a live conversation does.
    fs.writeFileSync(file, jsonlTurns(6));

    const second = await loadConversations();
    const countAfter = (second.msg.conversations.find(c => c.id === 'c-growing') || {}).messageCount;
    assert.ok(countAfter > countBefore,
      `a session that grew must be re-counted: caching must key on the file changing, `
      + `not simply on having seen it. Count went ${countBefore} -> ${countAfter}.`);
  });

  test('cost scales with what changed, not with how many conversations are held', async () => {
    const convos = [];
    for (let i = 0; i < 25; i++) {
      writeSession(`sess-bulk-${i}`, 2);
      convos.push({
        id: `c-bulk-${i}`, title: `Bulk ${i}`, agentId: 'chief-of-staff',
        sessionIds: [{ sessionId: `sess-bulk-${i}`, agentId: 'chief-of-staff' }],
      });
    }
    seedConversations(convos);

    await loadConversations();
    const steady = await loadConversations();

    assert.strictEqual(steady.sessionReads, 0,
      `with 25 conversations and nothing changed, a steady-state load must read no `
      + `session files at all. It read ${steady.sessionReads}. At 364 conversations `
      + `this is the difference between instant and a visible freeze.`);
  });
});
