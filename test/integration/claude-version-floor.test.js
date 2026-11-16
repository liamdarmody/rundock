'use strict';
// WHAT A PERSON SEES WHEN THE CLAUDE CODE RUNDOCK FOUND IS TOO OLD TO START.
//
// The stub answers --version with STUB_CLAUDE_VERSION, set here below the
// floor. Every path that starts Claude Code meets the check in spawnClaude: a
// new chat, a resumed one, a delegation and a routine run. Each says which
// copy was found and what to do, through the surface that path already
// reports a failed spawn on, and the stub is never handed the work. Then the
// copy is updated in place and the same conversation carries on, with no
// restart.
//
// Own file, own process: spawnClaude remembers a copy that passed for the
// life of the process, so nothing may start a passing copy here before the
// old-copy cases have run. The tests run in order.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');

const h = require('../helpers/harness.js');
const { agentFile, standardTeam } = require('../helpers/workspace.js');
const scheduler = require('../../lib/scheduler.js');

let client;
let stubBin;
let firstConvo;

before(async () => {
  await h.boot({
    agents: {
      ...standardTeam(),
      'note-keeper': agentFile({
        name: 'note-keeper', description: 'Keeps notes', type: 'specialist', order: 5, reportsTo: 'chief-of-staff',
        routines: [{ name: 'tidy', schedule: 'every day at 07:00', prompt: 'floor tidy', enabled: true }],
      }),
    },
  });
  h.internal.stopScheduler();
  stubBin = h.internal.resolveClaudeBin();
  process.env.STUB_CLAUDE_VERSION = '2.0.58';
  client = await h.connect();
});

after(async () => {
  delete process.env.STUB_CLAUDE_VERSION;
  await h.shutdown();
});

// What the floor says about the stub's copy, word for word, is held in
// test/unit/claude-version-floor.test.js. The stub's path is in this checkout,
// which can be long enough to be shortened in the notice, so each surface
// here is held to the floor's own notice for that path: the notice arrives
// whole, on every path, as the floor wrote it.
const notice = () => require('../../lib/runtime/claude-floor.js').tooOldError('2.0.58', stubBin).message;
const WHAT_TO_DO = 'The Rundock app looks for it in ~/.local/bin, ~/.claude/bin, /usr/local/bin and /opt/homebrew/bin first. '
  + 'Update that copy, or install a current one with the native installer, which puts it in ~/.local/bin. '
  + 'Then send your message again.';

const isInfo = (convoId) => (m) => m.type === 'system' && m.subtype === 'info' && m._conversationId === convoId;
const isDone = (convoId) => (m) => m.type === 'system' && m.subtype === 'done' && m._conversationId === convoId;

// A chat sent, and what reached the conversation up to its done.
async function sendAndSettle(convoId, extra = {}) {
  const since = client.messages.length;
  client.send({ type: 'chat', conversationId: convoId, agent: 'chief-of-staff', content: 'hello', ...extra });
  const { index } = await client.waitFor(isDone(convoId), { since, label: `done in ${convoId}` });
  return client.messages.slice(since, index + 1);
}

test('a new chat on a copy below the floor says which copy and what to do, starts nothing, and clears the thinking state', async () => {
  h.clearInvocations();
  firstConvo = h.freshConvoId('floornew');
  const seen = await sendAndSettle(firstConvo);
  const infos = seen.filter(isInfo(firstConvo));
  assert.deepStrictEqual(infos.map((m) => m.content), [notice()], 'the notice, once, in the conversation');
  assert.ok(infos[0].content.startsWith('Rundock found Claude Code 2.0.58 at '), infos[0].content);
  assert.ok(infos[0].content.endsWith(` Rundock needs 2.0.59 or later. ${WHAT_TO_DO}`), 'naming the folders and the two ways forward');
  assert.deepStrictEqual(h.readInvocations(), [], 'the stub was never handed the chat');
});

test('a resumed chat on a copy below the floor says the same, and starts nothing', async () => {
  h.clearInvocations();
  const convoId = h.freshConvoId('floorresume');
  const seen = await sendAndSettle(convoId, { sessionId: '7d1f0a52-4c1e-4b8e-9a51-1d2f3e4a5b6c' });
  assert.deepStrictEqual(seen.filter(isInfo(convoId)).map((m) => m.content), [notice()]);
  assert.deepStrictEqual(h.readInvocations(), [], 'the stub was never handed the resume');
});

test('sending again while the copy is still old starts nothing, and shows the notice again once the 30-second dedupe has passed', async (t) => {
  h.clearInvocations();
  const seen = await sendAndSettle(firstConvo);
  assert.deepStrictEqual(seen.filter(isInfo(firstConvo)), [], 'within 30 seconds the existing dedupe holds the notice back');
  assert.ok(seen.some(isDone(firstConvo)), 'and the thinking state clears');
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  try {
    t.mock.timers.tick(31000);
    const later = await sendAndSettle(firstConvo);
    assert.deepStrictEqual(later.filter(isInfo(firstConvo)).map((m) => m.content), [notice()], 'after them it is shown again');
  } finally {
    t.mock.timers.reset();
  }
  assert.deepStrictEqual(h.readInvocations(), [], 'and nothing was started either time');
});

test('a delegation on a copy below the floor says so in the parent conversation, and the parent is restored', async () => {
  h.clearInvocations();
  const convoId = h.freshConvoId('floordelegate');
  // The parent, parked as a conversation's answering agent. Its own process
  // is a stand-in: a Claude parent can only exist on a copy that passed.
  const proc = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(), stderr: new EventEmitter(),
    stdin: { writable: true, write: () => true, end: () => {} }, kill: () => {},
  });
  const parent = {
    process: proc, buffer: '', processId: 'floor-parent', agentId: 'chief-of-staff', responseText: '',
    exited: false, resultSent: false, toolCalls: [], turnStartTime: Date.now(), idle: true, idleSince: Date.now(),
  };
  h.internal.chatProcesses.set(convoId, parent);
  try {
    const since = client.messages.length;
    client.send({ type: 'delegate', conversationId: convoId, targetAgent: 'lead-designer', context: 'design the floor notice' });
    const { msg } = await client.waitFor(isInfo(convoId), { since, label: 'the notice in the parent conversation' });
    assert.strictEqual(msg.content, notice());
    await client.waitFor(isDone(convoId), { since, label: 'done' });
    await client.waitFor((m) => m.type === 'system' && m.subtype === 'agent_switch' && m._conversationId === convoId
      && m.toAgent === 'chief-of-staff', { since, label: 'back to the parent' });
    assert.strictEqual(h.internal.chatProcesses.get(convoId), parent, 'the parent answers the conversation again');
    assert.deepStrictEqual(h.readInvocations(), [], 'the delegate was never started');
  } finally {
    h.internal.chatProcesses.delete(convoId);
  }
});

test('a routine run on a copy below the floor records the notice as its failure reason, and starts nothing', async () => {
  h.clearInvocations();
  const before = scheduler.readRunRecords().length;
  client.send({ type: 'run_routine_now', agentId: 'note-keeper', name: 'tidy', occurrence: 0 });
  const ended = await h.waitUntil(() => scheduler.readRunRecords().length > before
    && !scheduler.runningRuns().some((r) => r.key === 'note-keeper:tidy'), { timeout: 10000 });
  assert.ok(ended, 'the run ended and left its record');
  const record = scheduler.readRunRecords().find((r) => r.routine === 'tidy');
  assert.ok(record, 'the record of the run');
  assert.strictEqual(record.status, 'failed');
  assert.strictEqual(record.error, notice());
  assert.deepStrictEqual(h.readInvocations(), [], 'the routine was never started');
});

test('after that copy is updated in place, the same message starts and the conversation carries on, with no restart', async () => {
  h.clearInvocations();
  process.env.STUB_CLAUDE_VERSION = '2.1.318';
  h.writeScenario([{ match: { agent: 'chief-of-staff' }, turn: [{ text: 'Carried on after the update.' }] }]);
  const since = client.messages.length;
  client.send({ type: 'chat', conversationId: firstConvo, agent: 'chief-of-staff', content: 'hello' });
  const { msg } = await client.waitFor((m) => m.type === 'result' && m._conversationId === firstConvo, { since, label: 'the turn' });
  assert.ok(String(msg.result).includes('Carried on after the update.'));
  const invocations = h.readInvocations();
  assert.strictEqual(invocations.length, 1, 'the updated copy was started');
  assert.strictEqual(invocations[0].agent, 'chief-of-staff');
  h.reapConvo(firstConvo);
});
