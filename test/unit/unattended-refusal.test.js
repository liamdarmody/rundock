'use strict';
// A REFUSAL IN A RUN NOBODY CAN BE ASKED FROM TELLS IT TO CARRY ON, OR TO FAIL
// IN WORDS THE RECORD READS.
//
// A refused card tells a conversation's agent to stop and ask the person what
// to do. A routine has nobody to ask: its output goes nowhere, and no reply can
// reach it. Told to stop and ask, a routine stopped there, with nothing saved,
// and its run still read as finished. So a routine is told to carry on without
// the refused step, or, if it cannot finish, to end its final message with the
// one line the run's record reads as a failure (RUN STATUS, docs/ROUTINES.md).
// A conversation, a delegated agent's included, keeps the words it had.
//
// A run is a routine's when its agent was started with no conversation. Every
// conversation spawn passes the conversation it belongs to, and only the
// scheduler passes none (unattended-spawn-paths.test.js holds that to the
// source), so
// the environment each spawn really builds (getSpawnEnv) is what these tests
// run the real hook with.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const config = require('../../lib/config.js');
const router = require('../../lib/http-router.js');
const claudeRt = require('../../lib/runtime/claude.js');
const { handlePermissionResponse } = require('../../lib/protocol/handlers/process-control.js');
const { declaredOutcome } = require('../../lib/scheduler.js');
const { refusalNotice, approvalNotice } = require('../../scripts/refusal-notice.js');

const ROOT = path.join(__dirname, '..', '..');
const HOOK = path.join(ROOT, 'scripts', 'permission-hook.js');

// Today's words, written out: a conversation keeps them exactly.
const ATTENDED = {
  denied: 'The person refused this command. The refusal is deliberate: do not retry it or try another way. Stop and ask the person what to do.',
  timeout: 'No one answered the request for this command in time, so it was refused. The refusal is deliberate: do not retry it or try another way. Stop and ask the person what to do.',
  sandbox: 'The workspace\'s sandbox settings blocked this command. The refusal is deliberate: do not retry it or try another way. Stop and ask the person what to do.',
};
const NEXT = 'This run has nobody to ask, so carry on with the rest of the job without that step. If you cannot finish without it, make the last line of your final message: RUN STATUS: failed: <one-line reason>';
const UNATTENDED = {
  denied: `The person refused this command. The refusal is deliberate: do not retry it or try another way. ${NEXT}`,
  timeout: `No one answered the request for this command in time, so it was refused. The refusal is deliberate: do not retry it or try another way. ${NEXT}`,
  sandbox: `The workspace's sandbox settings blocked this command. The refusal is deliberate: do not retry it or try another way. ${NEXT}`,
};
// Words that would tell an agent how to get round a refusal, or to wait on a
// person who is not there.
const WORKAROUND = /dangerouslyDisableSandbox|allowed_domains|settings\.local|permissions\.json|sudo|instead|use a different|try again/i;
const ASKS = /stop and ask|ask the person|ask the user|wait for/i;

describe('the wording', () => {
  test('a conversation keeps today\'s words exactly, with or without the option', () => {
    for (const kind of Object.keys(ATTENDED)) {
      assert.strictEqual(refusalNotice(kind, 'Bash'), ATTENDED[kind], kind);
      assert.strictEqual(refusalNotice(kind, 'Bash', { unattended: false }), ATTENDED[kind], kind);
      assert.strictEqual(refusalNotice(kind, 'Bash', {}), ATTENDED[kind], kind);
    }
  });

  test('a routine is told to carry on without the step, or to end on a failure line, and never to stop and ask', () => {
    for (const kind of Object.keys(UNATTENDED)) {
      assert.strictEqual(refusalNotice(kind, 'Bash', { unattended: true }), UNATTENDED[kind], kind);
      for (const tool of ['Bash', 'Read', 'mcp__example__send']) {
        const line = refusalNotice(kind, tool, { unattended: true });
        assert.ok(line.startsWith(refusalNotice(kind, tool).split(' The refusal')[0]), `${kind} ${tool}: says what was refused, as a conversation is told`);
        assert.match(line, /The refusal is deliberate: do not retry it or try another way\./);
        assert.match(line, /carry on with the rest of the job without that step\./);
        assert.match(line, /make the last line of your final message: RUN STATUS: failed: <one-line reason>$/);
        assert.doesNotMatch(line, ASKS, `${kind} ${tool}`);
        assert.doesNotMatch(line, WORKAROUND, `${kind} ${tool}`);
        assert.doesNotMatch(line, /[\u2013\u2014]/, 'no dashes');
        assert.ok(line.length <= 360, `short: ${line.length}`);
      }
    }
  });

  test('only a plain true makes a run unattended, and a bad option never throws', () => {
    for (const option of [null, undefined, 0, 'true', 1, { unattended: 'yes' }, { unattended: 1 }]) {
      assert.strictEqual(refusalNotice('denied', 'Bash', option), ATTENDED.denied, JSON.stringify(option));
    }
  });

  test('anything that is not a refusal still gets no line, attended or not', () => {
    for (const unattended of [true, false]) {
      assert.strictEqual(refusalNotice('allowed', 'Bash', { unattended }), null);
      assert.strictEqual(refusalNotice('constructor', 'Bash', { unattended }), null);
    }
  });

  test('a failure line written the way the routine is told is one the run record reads as failed, with its reason', () => {
    const template = NEXT.split('final message: ')[1];
    const said = `I read the inbox but could not open the calendar.\n\n${template.replace('<one-line reason>', 'the calendar could not be read')}`;
    assert.deepStrictEqual(declaredOutcome({ kind: 'text', text: said }), { status: 'failed', reason: 'the calendar could not be read' });
  });
});

// ── Through the real hook, spawned with the environment each kind of spawn really builds ──

const ROUTINE_SESSION = 'routine-session-1';
const ROUTINE_RUN = { id: 'run-1', routine: 'Morning briefing', agent: 'ada' };
let ws, outside, server, port, pending, sent, prevRouter, prevRt, prevWorkspace, timeoutMs;
// The scheduler's count, stood in for: every run id it was asked to count, in
// order, and a switch that makes it throw as a broken store would.
const counted = [];
let countThrows = false;
before(async () => {
  ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'unattended-refusal-')));
  outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'unattended-refusal-outside-')));
  fs.writeFileSync(path.join(outside, 'notes.md'), '# notes\n');
  fs.mkdirSync(path.join(ws, '.rundock'), { recursive: true });
  fs.writeFileSync(path.join(ws, '.rundock', 'state.json'), '{"workspaceMode":"knowledge"}\n');
  prevWorkspace = config.getWorkspace();
  config.setWorkspace(ws);
  pending = new Map();
  sent = [];
  timeoutMs = 60000;
  prevRouter = router.wireHttpRouterDeps({
    pendingPermissionRequests: () => pending,
    safeSend: (s) => sent.push(JSON.parse(s)),
    getPermissionTimeoutMs: () => timeoutMs,
    // The scheduler's own lookup, stood in for: the routine's session is its run's.
    routineRunForSession: (sid) => (sid === ROUTINE_SESSION ? ROUTINE_RUN : null),
    noteRefusedCard: (runId) => {
      if (countThrows) throw new Error('the runs folder cannot be written');
      counted.push(runId);
      return true;
    },
  });
  server = http.createServer(router.handleHttpRequest);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
  prevRt = claudeRt.wireClaudeRuntimeDeps({ getActualPort: () => port });
});
after(async () => {
  await new Promise((r) => server.close(r));
  router.wireHttpRouterDeps(prevRouter);
  claudeRt.wireClaudeRuntimeDeps(prevRt);
  if (prevWorkspace) config.setWorkspace(prevWorkspace);
  fs.rmSync(ws, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

// What the scheduler spawns a routine with, and what every conversation spawn,
// a delegated agent's included, spawns with.
const routineEnv = () => claudeRt.getSpawnEnv(null);
const conversationEnv = (convo) => claudeRt.getSpawnEnv(convo);

function runHook(env, input, { preload } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, preload ? ['--require', preload, HOOK] : [HOOK], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.on('close', () => { let parsed = null; try { parsed = JSON.parse(out); } catch (e) { /* raw kept */ } resolve({ raw: out, json: parsed }); });
    child.stdin.end(JSON.stringify(input));
  });
}
const outsideRead = (session) => ({ session_id: session, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: `cat ${path.join(outside, 'notes.md')}` }, cwd: ws });
async function waitFor(fn, ms = 10000) {
  const until = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > until) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 10));
  }
}
// Ask through the hook, and answer the card the router raised with the real
// handler, as a click in the window would. `allow` undefined leaves it to time out.
async function askAndAnswer(env, session, allow) {
  const since = sent.length;
  const answer = runHook(env, outsideRead(session));
  const card = await waitFor(() => sent.slice(since).find((m) => m.type === 'control_request'));
  if (allow !== undefined) {
    handlePermissionResponse({ pendingPermissions: pending, broadcast: () => {} }, { send() {} }, { requestId: card.request_id, conversationId: card._conversationId, allow, card: true });
  }
  return { card, out: (await answer).json };
}
const reasonOf = (out) => out.hookSpecificOutput.permissionDecisionReason;
// The hook's request is never answered: it times out on its own side, which is
// the path the hook takes when the server is alive but silent.
const NEVER_ANSWERS = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'unattended-refusal-preload-')), 'never-answers.js');
fs.writeFileSync(NEVER_ANSWERS, `
  const http = require('http');
  const { EventEmitter } = require('events');
  const real = http.request;
  http.request = function (opts, ...rest) {
    if (!opts || opts.path !== '/api/permission-request') return real.call(this, opts, ...rest);
    const req = new EventEmitter();
    req.write = () => true;
    req.destroy = () => {};
    req.end = () => { setImmediate(() => req.emit('timeout')); };
    return req;
  };
`);
after(() => fs.rmSync(path.dirname(NEVER_ANSWERS), { recursive: true, force: true }));
const sandboxFailure = (session) => ({
  session_id: session, hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_input: { command: 'cp -R ~/Downloads/x ./x' }, cwd: ws,
  error: 'Exit code 1\ncp: /Users/someone/Downloads/x: Operation not permitted\n<sandbox_violations>\ndeny file-write-create /Users/someone/Downloads/x\n</sandbox_violations>',
});

describe('a routine\'s refused card, through the real hook', () => {
  test('the routine\'s spawn names no conversation, and its card is the run\'s', async () => {
    assert.strictEqual(routineEnv().RUNDOCK_CONVO_ID, undefined);
    const { card, out } = await askAndAnswer(routineEnv(), ROUTINE_SESSION, false);
    assert.deepStrictEqual(card._run, ROUTINE_RUN, 'the card is attributed to the run, so this is the routine path');
    assert.strictEqual(out.hookSpecificOutput.permissionDecision, 'deny');
    assert.strictEqual(reasonOf(out), UNATTENDED.denied);
  });

  test('a card nobody answered in time is told the same way', async () => {
    timeoutMs = 50;
    try {
      const { out } = await askAndAnswer(routineEnv(), ROUTINE_SESSION);
      assert.strictEqual(out.hookSpecificOutput.permissionDecision, 'deny');
      assert.strictEqual(reasonOf(out), UNATTENDED.timeout);
    } finally { timeoutMs = 60000; }
  });

  test('the hook\'s own timeout, when the server never answers, is told the same way', async () => {
    const out = (await runHook(routineEnv(), outsideRead(ROUTINE_SESSION), { preload: NEVER_ANSWERS })).json;
    assert.strictEqual(out.hookSpecificOutput.permissionDecision, 'deny');
    assert.strictEqual(reasonOf(out), UNATTENDED.timeout);
  });

  test('a command the sandbox blocked is told the same way after the call', async () => {
    const out = (await runHook(routineEnv(), sandboxFailure(ROUTINE_SESSION))).json;
    assert.deepStrictEqual(out, { hookSpecificOutput: { hookEventName: 'PostToolUseFailure', additionalContext: UNATTENDED.sandbox } });
  });

  // The inverse action: an approval is told as it always was.
  test('an approved card still carries the approval line, unchanged', async () => {
    const { out } = await askAndAnswer(routineEnv(), ROUTINE_SESSION, true);
    assert.strictEqual(out.hookSpecificOutput.permissionDecision, 'allow');
    assert.strictEqual(reasonOf(out), 'Approved in Rundock');
    assert.strictEqual(out.hookSpecificOutput.additionalContext, approvalNotice('Bash'));
  });

  // The retry: the same call asked again is refused again, in the same words.
  test('a refused call asked again is refused again, in the same words', async () => {
    const first = (await askAndAnswer(routineEnv(), ROUTINE_SESSION, false)).out;
    const again = (await askAndAnswer(routineEnv(), ROUTINE_SESSION, false)).out;
    assert.strictEqual(again.hookSpecificOutput.permissionDecision, 'deny');
    assert.strictEqual(reasonOf(again), reasonOf(first));
    assert.strictEqual(reasonOf(again), UNATTENDED.denied);
  });
});

describe('a conversation\'s refused card keeps today\'s words, through the real hook', () => {
  test('denied, timed out, and the hook\'s own timeout', async () => {
    const env = conversationEnv('convo-attended');
    assert.strictEqual(env.RUNDOCK_CONVO_ID, 'convo-attended');
    assert.strictEqual(reasonOf((await askAndAnswer(env, 's-attended', false)).out), ATTENDED.denied);
    timeoutMs = 50;
    try {
      assert.strictEqual(reasonOf((await askAndAnswer(env, 's-attended')).out), ATTENDED.timeout);
    } finally { timeoutMs = 60000; }
    assert.strictEqual(reasonOf((await runHook(env, outsideRead('s-attended'), { preload: NEVER_ANSWERS })).json), ATTENDED.timeout);
  });

  test('a command the sandbox blocked', async () => {
    const out = (await runHook(conversationEnv('convo-attended-sbx'), sandboxFailure('s-attended-sbx'))).json;
    assert.deepStrictEqual(out, { hookSpecificOutput: { hookEventName: 'PostToolUseFailure', additionalContext: ATTENDED.sandbox } });
  });

  test('a session the scheduler does not know, in a conversation, is still the conversation\'s', async () => {
    // A delegated agent runs in its parent's conversation under a session of
    // its own: it is named by the conversation it was started with, not by
    // whether the scheduler knows its session.
    const { card, out } = await askAndAnswer(conversationEnv('convo-delegated'), ROUTINE_SESSION, false);
    assert.strictEqual(card._run, undefined, 'a conversation\'s card is never a run\'s');
    assert.strictEqual(reasonOf(out), ATTENDED.denied);
  });
});

// ── The route counts a routine's refused cards ──
//
// Counted where the card is settled, by the server, never by the agent: a
// denial clicked in the window, or a card left until it timed out. Each card
// is settled once, so it is counted once; a call asked again is a new card.

describe('the route counts a routine\'s refused cards, once each', () => {
  const countedSince = (n) => counted.slice(n);

  test('a denied card is counted once, against its run', async () => {
    const n = counted.length;
    const { card } = await askAndAnswer(routineEnv(), ROUTINE_SESSION, false);
    assert.deepStrictEqual(countedSince(n), [ROUTINE_RUN.id]);
    // A second click on the settled card finds nothing waiting, and counts nothing.
    handlePermissionResponse({ pendingPermissions: pending, broadcast: () => {} }, { send() {} }, { requestId: card.request_id, conversationId: '', allow: false, card: true });
    assert.deepStrictEqual(countedSince(n), [ROUTINE_RUN.id]);
  });

  test('a card nobody answered in time is counted once', async () => {
    timeoutMs = 50;
    const n = counted.length;
    try {
      await askAndAnswer(routineEnv(), ROUTINE_SESSION);
    } finally { timeoutMs = 60000; }
    assert.deepStrictEqual(countedSince(n), [ROUTINE_RUN.id]);
  });

  test('an approved card is not counted', async () => {
    const n = counted.length;
    const { out } = await askAndAnswer(routineEnv(), ROUTINE_SESSION, true);
    assert.strictEqual(out.hookSpecificOutput.permissionDecision, 'allow');
    assert.deepStrictEqual(countedSince(n), []);
  });

  test('a conversation\'s refused card is not counted, timed out or denied', async () => {
    const n = counted.length;
    await askAndAnswer(conversationEnv('chat-2'), ROUTINE_SESSION, false);
    timeoutMs = 50;
    try { await askAndAnswer(conversationEnv('chat-2'), 'chat-session-2'); } finally { timeoutMs = 60000; }
    assert.deepStrictEqual(countedSince(n), []);
  });

  test('a card whose asker went away is not counted', async () => {
    const n = counted.length;
    const since = sent.length;
    const child = spawn(process.execPath, [HOOK], { env: routineEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdin.end(JSON.stringify(outsideRead(ROUTINE_SESSION)));
    const card = await waitFor(() => sent.slice(since).find((m) => m.type === 'control_request'));
    child.kill('SIGKILL');
    await waitFor(() => sent.slice(since).find((m) => m.type === 'permission_ended' && m.requestId === card.request_id));
    assert.strictEqual(pending.has(card.request_id), false);
    assert.deepStrictEqual(countedSince(n), []);
  });

  // The retry: each refusal is its own card, so each is counted.
  test('a call refused, asked again and refused again is counted twice', async () => {
    const n = counted.length;
    await askAndAnswer(routineEnv(), ROUTINE_SESSION, false);
    await askAndAnswer(routineEnv(), ROUTINE_SESSION, false);
    assert.deepStrictEqual(countedSince(n), [ROUTINE_RUN.id, ROUTINE_RUN.id]);
  });

  // The control failing: a count that throws costs the count, never the answer.
  test('a count that throws still refuses, in the routine\'s words, and the route keeps answering', async () => {
    countThrows = true;
    try {
      const denied = (await askAndAnswer(routineEnv(), ROUTINE_SESSION, false)).out;
      assert.strictEqual(denied.hookSpecificOutput.permissionDecision, 'deny');
      assert.strictEqual(reasonOf(denied), UNATTENDED.denied);
      timeoutMs = 50;
      let late;
      try { late = (await askAndAnswer(routineEnv(), ROUTINE_SESSION)).out; } finally { timeoutMs = 60000; }
      assert.strictEqual(late.hookSpecificOutput.permissionDecision, 'deny');
      assert.strictEqual(reasonOf(late), UNATTENDED.timeout);
    } finally { countThrows = false; }
    const n = counted.length;
    const next = (await askAndAnswer(routineEnv(), ROUTINE_SESSION, false)).out;
    assert.strictEqual(reasonOf(next), UNATTENDED.denied);
    assert.deepStrictEqual(countedSince(n), [ROUTINE_RUN.id], 'and the next refusal is counted again');
  });
});

// ── A subagent a routine starts ──
//
// A routine's agent can start a subagent with its Task tool. That subagent runs
// inside the routine's own process, and the runtime calls the hook for it with
// the routine's session id, adding only `agent_id` and `agent_type` (measured,
// in test/fixtures/subagent-hook-payload.json). So its cards are the run's,
// found by the session as the routine's own are, and counted on its record.
// A routine cannot reach Rundock's own delegation at all: that is read from a
// conversation's output, and a routine's output is never read
// (test/integration/unattended-refusal.test.js drives both).
describe('a subagent a routine starts raises its cards as the routine', () => {
  const measured = require('../fixtures/subagent-hook-payload.json');

  test('the runtime calls the hook for a subagent with its parent\'s session id', () => {
    assert.strictEqual(measured.subagent.session_id, measured.parent.session_id);
    assert.strictEqual(typeof measured.subagent.agent_id, 'string');
    assert.strictEqual(measured.subagent.agent_type, 'general-purpose');
    assert.ok(!('agent_id' in measured.parent) && !('agent_type' in measured.parent), 'the parent\'s own call names no subagent');
    const { agent_id: id, agent_type: type, tool_use_id: a, ...rest } = measured.subagent;
    const { tool_use_id: b, ...parentRest } = measured.parent;
    assert.deepStrictEqual(rest, parentRest, 'and nothing else in the call tells the two apart');
  });

  test('so a subagent\'s refused card is the run\'s card, counted once on it, in the routine\'s words', async () => {
    const n = counted.length;
    const since = sent.length;
    // The measured subagent call, in the routine's session, asking for a read
    // outside the workspace the way the routine's own call would.
    const { tool_name: tn, tool_input: ti, transcript_path: tp, cwd: c, ...shape } = measured.subagent;
    const call = { ...shape, ...outsideRead(ROUTINE_SESSION) };
    assert.strictEqual(call.agent_id, measured.subagent.agent_id);
    const answer = runHook(routineEnv(), call);
    const card = await waitFor(() => sent.slice(since).find((m) => m.type === 'control_request'));
    assert.deepStrictEqual(card._run, { id: ROUTINE_RUN.id, routine: ROUTINE_RUN.routine, agent: ROUTINE_RUN.agent });
    handlePermissionResponse({ pendingPermissions: pending, broadcast: () => {} }, { send() {} }, { requestId: card.request_id, conversationId: card._conversationId, allow: false, card: true });
    const out = (await answer).json;
    assert.strictEqual(reasonOf(out), UNATTENDED.denied);
    assert.deepStrictEqual(counted.slice(n), [ROUTINE_RUN.id]);
  });
});
