'use strict';
// A WRITE TO AN AGENT PROCESS THAT HAS ALREADY STOPPED.
//
// The server sends every message to an agent on its process's stdin. A
// process can stop before the server has heard that it stopped: Claude Code
// refuses a resume and exits before reading anything, or it crashes, or it is
// ended, and the message written in that gap goes to a pipe nobody reads.
// The write then fails with EPIPE, asynchronously, as an `error` event on the
// stdin stream. With nothing listening for it, Node treats it as an uncaught
// exception, which ends the server and every conversation in it.
//
// Two ways to reach that gap, both through the real server and the stub
// runtime:
//
//   - A WRITE STILL GOING WHEN THE PROCESS STOPS. A delegate whose stored
//     session is gone is refused at startup and exits without reading its
//     brief. A brief larger than the pipe holds is still being written when
//     it exits, and the rest of the write fails.
//   - A WRITE MADE AFTER THE PROCESS STOPPED. The test ends a conversation's
//     process and waits, without letting the server run, until the process
//     is gone, then hands the server the person's next message in the same
//     tick. The server has not heard of the exit, so it writes the message to
//     the process that has stopped.
//
// What must happen instead: the failed write is logged in one line naming the
// process, the server stays up, and the process's own close path ends its turn
// or its delegation exactly once, as it does for any process that stops.
//
// An uncaught exception is recorded here by a monitor, which sees it before
// the test runner's own handler turns it into a failure of the file, so the
// test that caused it is the one that fails.
const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const h = require('../helpers/harness.js');
const { startingFresh } = require('../../lib/runtime/missing-session.js');

// The guard's logging seam, where it exists.
const seam = (() => {
  try { return require('../../lib/runtime/child-stdin.js'); } catch (e) {
    if (e && e.code === 'MODULE_NOT_FOUND' && /child-stdin/.test(String(e.message))) return null;
    throw e;
  }
})();

const uncaught = [];
process.on('uncaughtExceptionMonitor', (err) => { uncaught.push(err); });

// Every line the guard logs. It logs through console.error. And how many
// messages the window had when each was logged, so a test can tell what was
// said after a write failed.
const stdinLines = [];
const stdinAt = [];
const realConsoleError = console.error;

let client;
before(async () => {
  console.error = (...args) => {
    const line = args.map((a) => (a instanceof Error ? a.message : String(a))).join(' ');
    if (line.startsWith('[Stdin]')) { stdinLines.push(line); stdinAt.push(client ? client.messages.length : 0); }
    realConsoleError.apply(console, args);
  };
  await h.boot();
  client = await h.connect();
});
after(async () => {
  console.error = realConsoleError;
  await h.shutdown();
});
beforeEach(() => { uncaught.length = 0; stdinLines.length = 0; stdinAt.length = 0; });

// More than a pipe to a child holds on any platform this runs on, so a
// write of it is still going when a child that never reads it exits.
const BIG = 1024 * 1024;

// Each test is bounded, so a write that a broken handler leaves half torn
// down fails its test rather than holding the file open.
const LIMIT = { timeout: 60000 };

function scenario(rules, deadSessions = [], extra = {}) {
  fs.writeFileSync(path.join(h.workspaceDir, 'stub-scenario.json'), JSON.stringify({ ...extra, rules, deadSessions }));
}

function seed(convoId, record) {
  const all = h.internal.readConversations().filter((c) => c.id !== convoId);
  h.internal.writeConversations([{ id: convoId, title: convoId, status: 'active', ...record }, ...all]);
}

function messagesFor(convoId, since = 0) {
  return client.messages.slice(since).filter((m) => m._conversationId === convoId);
}

function spawnsFor(convoId) {
  return h.readInvocations().filter((i) => i.env && i.env.RUNDOCK_CONVO_ID === convoId);
}

function waitForResult(convoId, text, since, label) {
  return client.waitFor((m) => m.type === 'result' && m._conversationId === convoId && String(m.result || '').includes(text),
    { since, label: label || `result ${text}`, timeout: 20000 });
}

/** The server's end of the test's own window. */
function serverSocket() {
  const ws = [...h.internal.wss.clients].find((c) => c.readyState === 1);
  assert.ok(ws, 'the window is connected');
  return ws;
}

/**
 * End a child and return only once it has gone, without letting the server
 * run in between: nothing here yields to the event loop, so the server cannot
 * have processed the exit by the time this returns. Gone is read from the pipe
 * itself: a write to it is refused once nothing can read it, with EPIPE, or
 * on macOS sometimes ENOTCONN, which says the same. The line written is a
 * blank one, which an agent reading stream-json skips.
 */
const READER_GONE = new Set(['EPIPE', 'ENOTCONN', 'ECONNRESET']);
function endUnheard(child) {
  const fd = child.stdin && child.stdin._handle && child.stdin._handle.fd;
  assert.ok(Number.isInteger(fd) && fd >= 0, 'the child\'s stdin is a pipe this platform can write to directly');
  process.kill(child.pid, 'SIGKILL');
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try { fs.writeSync(fd, '\n'); } catch (e) {
      if (READER_GONE.has(e.code)) return;
      if (e.code !== 'EAGAIN') throw e;
    }
  }
  assert.fail('the child did not stop within ten seconds of SIGKILL');
}

/** A conversation with one answered turn, its process alive and idle. */
async function liveConversation(prefix) {
  const convoId = h.freshConvoId(prefix);
  const tag = prefix.toUpperCase();
  scenario([
    { match: { promptIncludes: `ONE-${tag}` }, turn: [{ text: `ANSWER-ONE-${tag}` }] },
    { match: { promptIncludes: `TWO-${tag}` }, turn: [{ text: `ANSWER-TWO-${tag}` }] },
    { match: { promptIncludes: `AGAIN-${tag}` }, turn: [{ text: `ANSWER-AGAIN-${tag}` }] },
  ]);
  const since = client.messages.length;
  client.send({ type: 'chat', conversationId: convoId, agent: 'chief-of-staff', content: `ONE-${tag} first` });
  await waitForResult(convoId, `ANSWER-ONE-${tag}`, since);
  // And for the done that ends this turn, which is a frame of its own: one
  // that arrived after a caller took its `since` was counted as ending the
  // caller's turn instead (seen on a loaded CI runner).
  await client.waitFor((m) => m.type === 'system' && m.subtype === 'done' && m._conversationId === convoId,
    { since, label: 'the first turn ended', timeout: 20000 });
  await h.waitUntil(() => { const e = h.internal.chatProcesses.get(convoId); return Boolean(e && e.idle); });
  const entry = h.internal.chatProcesses.get(convoId);
  assert.ok(entry && entry.process && !entry.exited, 'the conversation has a live process');
  return { convoId, tag, entry };
}

/** The person's next message, handed to the server in this same tick. */
function sendNow(convoId, content) {
  serverSocket().emit('message', JSON.stringify({ type: 'chat', conversationId: convoId, agent: 'chief-of-staff', content }));
}

/** Wait until the server has heard a process end, and run what its close does. */
async function closed(entry) {
  await h.waitUntil(() => entry.process.exitCode !== null || entry.process.signalCode !== null);
  await h.waitUntil(() => entry.exited);
  await h.delay(50);
}

function assertServerUp(label) {
  assert.deepStrictEqual(uncaught.map((e) => `${e.code || ''} ${e.message}`), [],
    `${label}: nothing may reach the process as an uncaught exception, which would end the server`);
}

/** The turn the follow-up started is ended once, by its process's close, and nothing else is said. */
function assertEndedOnce(convoId, since, processId) {
  const after = messagesFor(convoId, since);
  const started = after.filter((m) => m.type === 'system' && m.subtype === 'process_started' && m._processId === processId);
  const done = after.filter((m) => m.type === 'system' && m.subtype === 'done' && m._processId === processId);
  assert.strictEqual(started.length, 1, 'the follow-up started one turn');
  assert.strictEqual(done.length, 1, 'and that turn is ended exactly once, so no spinner is left running');
  assert.ok(after.indexOf(done[0]) > after.indexOf(started[0]), 'ended after it started');
  assert.deepStrictEqual(after.filter((m) => m.type === 'error').map((m) => m.content), [],
    'the failed write shows the person no error of its own');
}

describe('a message written to a conversation whose process has just stopped', () => {
  test('is logged in one line naming the process, the server stays up, and the close ends the turn once', LIMIT, async () => {
    const { convoId, tag, entry } = await liveConversation('gone');
    const since = client.messages.length;
    endUnheard(entry.process);
    sendNow(convoId, `LOST-${tag} written to a process that has stopped`);
    await closed(entry);

    assertServerUp('a follow-up to a stopped process');
    assert.strictEqual(stdinLines.length, 1, `one line, for the one failed write: ${JSON.stringify(stdinLines)}`);
    assert.match(stdinLines[0], /chief-of-staff/, 'naming the agent whose process it was');
    assert.match(stdinLines[0], new RegExp(`pid=${entry.process.pid}\\b`), 'and the process');
    assert.match(stdinLines[0], /EPIPE|ENOTCONN|ECONNRESET/, 'and the error');
    assertEndedOnce(convoId, since, entry.processId);
    assert.ok(!h.internal.chatProcesses.has(convoId), 'the stopped process is no longer the conversation\'s');

    // THE MOST COMMON NEXT STEP: the person sends again. A fresh process takes
    // it and answers, in the same conversation.
    const next = client.messages.length;
    client.send({ type: 'chat', conversationId: convoId, agent: 'chief-of-staff', content: `AGAIN-${tag} once more` });
    await waitForResult(convoId, `ANSWER-AGAIN-${tag}`, next, 'the next message is answered');
    assert.deepStrictEqual(spawnsFor(convoId).length, 2, 'by one fresh process');
    assert.strictEqual(stdinLines.length, 1, 'which logs nothing: it was written to a live process');
    assertServerUp('the message after it');
    h.reapConvo(convoId);
  });

  test('the inverse: a follow-up to a live process is delivered exactly as before, and its turn runs', LIMIT, async () => {
    const { convoId, tag, entry } = await liveConversation('alive');
    const since = client.messages.length;
    sendNow(convoId, `TWO-${tag} second`);
    await waitForResult(convoId, `ANSWER-TWO-${tag}`, since, 'the follow-up is answered');
    assert.deepStrictEqual(h.promptsFor('chief-of-staff').filter((p) => p.includes(`-${tag} `)),
      [`ONE-${tag} first`, `TWO-${tag} second`], 'each message reached the agent once, as sent');
    assert.strictEqual(spawnsFor(convoId).length, 1, 'by the same process');
    assert.strictEqual(h.internal.chatProcesses.get(convoId), entry, 'which is still the conversation\'s');
    assert.deepStrictEqual(stdinLines, [], 'nothing failed, so nothing is logged');
    assertServerUp('a follow-up to a live process');
    h.reapConvo(convoId);
  });

  test('the undo: a stopped conversation sent a message straight away starts a new process and answers it', LIMIT, async () => {
    const convoId = h.freshConvoId('undo');
    scenario([
      { match: { promptIncludes: 'LONG-UNDO' }, delayMs: 30000, turn: [{ text: 'SHOULD-NOT-FINISH-UNDO' }] },
      { match: { promptIncludes: 'AFTER-UNDO' }, turn: [{ text: 'ANSWER-AFTER-UNDO' }] },
    ]);
    const since = client.messages.length;
    client.send({ type: 'chat', conversationId: convoId, agent: 'chief-of-staff', content: 'LONG-UNDO take your time' });
    await client.waitFor((m) => m.subtype === 'process_started' && m._conversationId === convoId, { since, label: 'the turn starts' });
    await h.waitUntil(() => h.promptsFor('chief-of-staff').some((p) => p.includes('LONG-UNDO')));
    const stopped = h.internal.chatProcesses.get(convoId);
    // The stop and the next message, back to back: the second is read before
    // the stopped process has gone.
    serverSocket().emit('message', JSON.stringify({ type: 'cancel', conversationId: convoId }));
    sendNow(convoId, 'AFTER-UNDO and now this');
    await waitForResult(convoId, 'ANSWER-AFTER-UNDO', since, 'the message after the stop is answered');
    await closed(stopped);

    assertServerUp('a message sent the moment a conversation is stopped');
    assert.strictEqual(spawnsFor(convoId).length, 2, 'by a new process, as it is today');
    assert.notStrictEqual(h.internal.chatProcesses.get(convoId), stopped, 'not by the one that was stopped');
    assert.deepStrictEqual(stdinLines, [], 'nothing was written to the stopped process, so nothing failed');
    assert.ok(!messagesFor(convoId, since).some((m) => m.type === 'result' && /SHOULD-NOT-FINISH-UNDO/.test(m.result || '')));
    assert.strictEqual(messagesFor(convoId, since).filter((m) => m.subtype === 'cancelled').length, 1, 'stopped once');
    h.reapConvo(convoId);
  });

  test('the control failing: when the log line itself cannot be written, the server still stays up', LIMIT, async () => {
    const { convoId, tag, entry } = await liveConversation('broken-log');
    const since = client.messages.length;
    const restore = seam ? seam.failureLog.write : null;
    if (seam) seam.failureLog.write = () => { throw new Error('the log is broken'); };
    try {
      endUnheard(entry.process);
      sendNow(convoId, `LOST-${tag} written to a process that has stopped`);
      await closed(entry);
    } finally {
      if (seam) seam.failureLog.write = restore;
    }
    assertServerUp('a failed write whose log line throws');
    assertEndedOnce(convoId, since, entry.processId);
    const next = client.messages.length;
    client.send({ type: 'chat', conversationId: convoId, agent: 'chief-of-staff', content: `AGAIN-${tag} once more` });
    await waitForResult(convoId, `ANSWER-AGAIN-${tag}`, next, 'and it goes on answering');
    h.reapConvo(convoId);
  });
});

describe('a delegate whose resume is refused before it reads its brief', () => {
  // The brief is still being written when Claude Code refuses the resume and
  // the delegate exits, which is the write that took the server down.
  function delegation(prefix, extra = {}) {
    const convoId = h.freshConvoId(prefix);
    const tag = prefix.toUpperCase();
    seed(convoId, {
      agentId: 'chief-of-staff', sessionId: `live-orch-${prefix}`,
      sessionIds: [{ agentId: 'chief-of-staff', sessionId: `live-orch-${prefix}` }, { agentId: 'content-lead', sessionId: `dead-lead-${prefix}` }],
    });
    scenario([
      { match: { resume: true, promptIncludes: `ASK-${tag}`, promptExcludes: 'DELEGATION BRIEF' },
        turn: [{ agentTool: { subagent_type: 'content-lead', description: 'Over to the lead.', prompt: `BRIEF-${tag} ${'x'.repeat(BIG)}` } }] },
      { match: { agent: 'content-lead', promptIncludes: `BRIEF-${tag}` }, turn: [{ text: `LEAD-FRESH-${tag} is done. <!-- RUNDOCK:COMPLETE -->` }] },
      { match: { agent: 'content-lead', promptIncludes: `FOLLOW-${tag}` }, turn: [{ text: `LEAD-FOLLOWED-${tag}` }] },
      { match: { agent: 'chief-of-staff', promptIncludes: 'pipeline-complete' }, turn: [{ text: '<silent>' }] },
      { match: { agent: 'chief-of-staff', promptIncludes: `NEXT-${tag}` }, turn: [{ text: `ORCH-NEXT-${tag}` }] },
    ], [`dead-lead-${prefix}`], extra);
    h.clearInvocations();
    return { convoId, tag, prefix };
  }

  test('the failed write is logged once, the delegate starts fresh once, and the orchestrator hears of it once and carries on', LIMIT, async () => {
    const { convoId, tag, prefix } = delegation('refused');
    const since = client.messages.length;
    client.send({ type: 'chat', conversationId: convoId, agent: 'chief-of-staff', content: `ASK-${tag} please`, sessionId: `live-orch-${prefix}` });
    await waitForResult(convoId, `LEAD-FRESH-${tag}`, since, 'the delegate answers from a fresh session');
    await h.waitUntil(() => h.promptsFor('chief-of-staff').some((p) => p.includes('pipeline-complete')));
    await h.delay(200);

    assertServerUp('a brief written to a delegate that was refused and exited');
    assert.strictEqual(stdinLines.length, 1, `one line, for the one failed write: ${JSON.stringify(stdinLines)}`);
    assert.match(stdinLines[0], /content-lead/, 'naming the delegate');
    assert.match(stdinLines[0], /EPIPE/, 'and the error');

    const lead = spawnsFor(convoId).filter((i) => i.agent === 'content-lead');
    assert.deepStrictEqual(lead.map((i) => i.resume), [`dead-lead-${prefix}`, null],
      'the refused process\'s close starts the delegate again fresh, once, as it does today');
    const after = messagesFor(convoId, since);
    assert.strictEqual(after.filter((m) => m.subtype === 'info' && m.expiredSessionId === `dead-lead-${prefix}`).length, 1,
      'the person is told once that it started fresh');
    assert.strictEqual(after.filter((m) => m.type === 'result' && String(m.result || '').includes(`LEAD-FRESH-${tag}`)).length, 1,
      'the delegate answers once');
    assert.deepStrictEqual(after.filter((m) => m.type === 'error').map((m) => m.content), [],
      'the failed write shows the person no error of its own');
    assert.strictEqual(h.promptsFor('chief-of-staff').filter((p) => p.includes(`LEAD-FRESH-${tag}`)).length, 1,
      'the orchestrator that delegated is handed the delegate\'s result once');

    // THE MOST COMMON NEXT STEP: carry on in the same conversation.
    const next = client.messages.length;
    client.send({ type: 'chat', conversationId: convoId, agent: 'chief-of-staff', content: `NEXT-${tag} what now` });
    await waitForResult(convoId, `ORCH-NEXT-${tag}`, next, 'the orchestrator answers the next message');
    assertServerUp('the message after the delegation');
    h.reapConvo(convoId);
  });

  test('the retry: a second write to the same refused delegate is logged once more and ends nothing a second time', LIMIT, async () => {
    // Two writes made after the refused delegate has stopped, before the
    // server has heard: the delegate is ended and gone, and the person's two
    // messages are handed to the server in that same tick. Its brief is still
    // being written, as in the test above, which is what lets both reach the
    // same child: with nothing waiting in the pipe, the first of them fails at
    // once and the second goes to a new process instead. Three writes fail:
    // the brief, and the two made after the delegate stopped.
    const { convoId, tag, prefix } = delegation('retried', { refusalExitMs: 1500 });
    try {
      const since = client.messages.length;
      client.send({ type: 'chat', conversationId: convoId, agent: 'chief-of-staff', content: `ASK-${tag} please`, sessionId: `live-orch-${prefix}` });
      await client.waitFor((m) => m.subtype === 'session_expired' && m._conversationId === convoId,
        { since, label: 'the delegate is refused and still lingering', timeout: 20000 });
      const refusedEntry = h.internal.chatProcesses.get(convoId);
      assert.ok(refusedEntry && refusedEntry.agentId === 'content-lead', 'the refused delegate is the conversation\'s');
      const refusedProcess = refusedEntry.process;
      assert.ok(refusedProcess.stdin.writableLength > 0, 'its brief is still being written');
      const toLead = (content) => serverSocket().emit('message', JSON.stringify({ type: 'chat', conversationId: convoId, agent: 'content-lead', content }));
      endUnheard(refusedProcess);
      toLead(`FOLLOW-${tag} first`);
      toLead(`FOLLOW-${tag} second`);
      assert.ok(h.internal.chatProcesses.get(convoId) === refusedEntry && refusedEntry.process === refusedProcess && !refusedEntry.exited
        && refusedProcess.exitCode === null && refusedProcess.signalCode === null,
        'both were written to the stopped delegate, still the conversation\'s, whose exit the server had not yet heard');
      const followed = () => messagesFor(convoId, since).filter((m) => m.type === 'result' && String(m.result || '').includes(`LEAD-FOLLOWED-${tag}`));
      assert.ok(await h.waitUntil(() => followed().length === 2, { timeout: 20000 }), 'both messages are answered by the fresh delegate');
      await h.delay(200);

      assertServerUp('two writes to a delegate that had stopped');
      assert.strictEqual(stdinLines.length, 3, `one line per failed write, the brief and the two after: ${JSON.stringify(stdinLines)}`);
      for (const line of stdinLines) {
        assert.match(line, new RegExp(`^\\[Stdin\\] claude \\(agent content-lead, conversation ${convoId}\\) pid=${refusedProcess.pid}: a write failed `),
          'each naming the stopped delegate');
      }
      assert.match(stdinLines[0], /\((EPIPE|ENOTCONN|ECONNRESET): /, 'the first refused by the pipe');
      for (const line of stdinLines.slice(1)) {
        assert.match(line, /\((EPIPE|ENOTCONN|ECONNRESET|ERR_STREAM_DESTROYED): /, 'the rest by the pipe, or by the stream the first failure closed');
      }
      const lead = spawnsFor(convoId).filter((i) => i.agent === 'content-lead');
      assert.deepStrictEqual(lead.map((i) => i.resume), [`dead-lead-${prefix}`, null], 'started fresh once, not once per failed write');
      const after = messagesFor(convoId, since);
      assert.strictEqual(after.filter((m) => m.subtype === 'info' && m.expiredSessionId === `dead-lead-${prefix}`).length, 1,
        'and said once');
      const prompts = h.promptsFor('content-lead');
      assert.strictEqual(prompts.filter((p) => p.includes(`BRIEF-${tag}`)).length, 1, 'the fresh delegate is briefed once');
      assert.deepStrictEqual(prompts.filter((p) => p.includes(`FOLLOW-${tag}`)), [`FOLLOW-${tag} first`, `FOLLOW-${tag} second`],
        'and given each of the person\'s messages once, as sent, in order');
      assert.deepStrictEqual(after.filter((m) => m.type === 'error').map((m) => m.content), []);

      // Read once the delegation has ended: the delegate auto-returns, and the
      // orchestrator is handed what it did.
      await h.waitUntil(() => h.promptsFor('chief-of-staff').some((p) => p.includes('pipeline-complete')), { timeout: 20000 });
      await h.delay(300);
      const all = messagesFor(convoId, since);

      // THE REFUSED PROCESS ENDED ONCE, BY ITS CLOSE. Neither failed write ended
      // anything: its close did, once, as it ends any refused resume, by starting
      // the delegate again fresh and saying why. The fresh delegate keeps the
      // entry, and with it the process id, so the delegate's messages are read
      // in order: what ends the refused process, each answered turn's done, and
      // the delegation's own end.
      const ofDelegate = all.filter((m) => m._processId === refusedEntry.processId);
      const leadName = h.internal.discoverAgents().find((a) => a.id === 'content-lead').displayName;
      assert.deepStrictEqual(ofDelegate.filter((m) => m.type === 'system' && m.subtype === 'info').map((m) => [m.content, m.expiredSessionId]),
        [[startingFresh(leadName), `dead-lead-${prefix}`]],
        'the refused process ends exactly once, the way its close path ends a refused resume: the session was gone, so the delegate starts fresh');
      const freshAt = ofDelegate.findIndex((m) => m.type === 'system' && m.subtype === 'info');
      assert.deepStrictEqual(ofDelegate.slice(0, freshAt).filter((m) => m.type === 'system' && ['done', 'cancelled'].includes(m.subtype)), [],
        'and nothing else ends it: no turn or delegation is ended for the refused process');
      // A done no result came just before ends what a process was doing when it
      // closed; one straight after a result ends that answered turn.
      const ended = ofDelegate.filter((m, i) => m.type === 'system' && m.subtype === 'done' && !(i > 0 && ofDelegate[i - 1].type === 'result'));
      assert.strictEqual(ended.length, 1, `the delegation ends exactly once, not once per failed write: ${JSON.stringify(ended)}`);

      // THE ORCHESTRATOR HEARS ONCE, after both writes have failed.
      const handedBack = all.filter((m) => m.type === 'system' && m.subtype === 'agent_switch' && m.returning);
      assert.deepStrictEqual(handedBack.map((m) => [m.fromAgent, m.toAgent]), [['content-lead', 'chief-of-staff']],
        'the conversation is handed back to the orchestrator once');
      const backAt = client.messages.indexOf(handedBack[0]);
      assert.ok(stdinAt.length === 3 && stdinAt.every((n) => n <= backAt), 'and only after every write had failed');
      assert.strictEqual(h.promptsFor('chief-of-staff').filter((p) => p.includes(`LEAD-FRESH-${tag}`)).length, 1,
        'the orchestrator is handed the delegate\'s result exactly once');
      assertServerUp('the delegation\'s end');
    } finally {
      // Whatever the outcome, every process this conversation started is
      // reaped, so a run that fails ends at its failure: a child left over by
      // a broken guard would otherwise hold this file open.
      for (const { pid } of spawnsFor(convoId)) {
        try { process.kill(pid, 'SIGKILL'); } catch (e) { /* already gone */ }
      }
      h.reapConvo(convoId);
    }
  });
});
