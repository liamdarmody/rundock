'use strict';
// Unit tests for the Codex app-server protocol client (codex-appserver.js),
// driven against the REAL stub binary in app-server mode: the client spawns
// test/helpers/stub-codex/codex with binPath injected, exactly like the
// repo's other integration-grade unit tests drive stub runtimes. Wire shapes
// come from test/fixtures/codex-appserver-protocol.js, the same fixtures the
// stub emits, so client and harness cannot drift apart.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { spawn } = require('node:child_process');

const { createCodexAppServer, normalizeErrorKind, parseUserAgentVersion } = require('../../codex-appserver.js');
const asfx = require('../fixtures/codex-appserver-protocol.js');

const STUB_BIN = path.join(__dirname, '..', 'helpers', 'stub-codex', 'codex');

// ── Harness ─────────────────────────────────────────────────────────────────

const dirs = [];
function makeDir(scenario) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-appserver-'));
  dirs.push(dir);
  if (scenario) writeScenario(dir, scenario);
  return dir;
}

function writeScenario(dir, scenario) {
  fs.writeFileSync(path.join(dir, 'stub-codex-scenario.json'), JSON.stringify(scenario, null, 2));
}

function readInvocations(dir) {
  const file = path.join(dir, 'stub-invocations.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf-8').split('\n').filter(Boolean).map(l => JSON.parse(l));
}

// The stub appends to the invocation log asynchronously as it processes its
// stdin; poll briefly instead of racing it.
async function waitForInvocation(dir, pred, { timeout = 2000 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const hit = readInvocations(dir).find(pred);
    if (hit) return hit;
    if (Date.now() > deadline) throw new Error('timed out waiting for a stub invocation entry');
    await new Promise(r => setTimeout(r, 10));
  }
}

// Tiny injectable timings so backoff and timeout paths run in milliseconds.
function makeServer(dir, opts = {}) {
  return createCodexAppServer({
    binPath: STUB_BIN,
    cwd: dir,
    requestTimeoutMs: 5000,
    approvalTimeoutMs: 60000,
    overloadRetry: { attempts: 3, baseMs: 10, maxMs: 40 },
    restartBackoff: { baseMs: 25, maxMs: 100 },
    shutdownGraceMs: 1000,
    ...opts,
  });
}

function record(sub) {
  const events = [];
  sub.on('event', e => events.push(e));
  return events;
}

// Generous default: these tests run concurrently with the whole suite, and
// a starved stub process under full parallel load can push an event past a
// tight window (observed: 'done' after interrupt landing just beyond 5s).
function nextEvent(sub, type, { timeout = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      sub.removeListener('event', onEvent);
      reject(new Error(`timed out waiting for '${type}' turn event`));
    }, timeout);
    function onEvent(e) {
      if (e.type !== type) return;
      clearTimeout(timer);
      sub.removeListener('event', onEvent);
      resolve(e);
    }
    sub.on('event', onEvent);
  });
}

function within(ms) { return AbortSignal.timeout(ms); }

test.after(() => {
  for (const dir of dirs.splice(0)) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* best-effort */ }
  }
});

// ── Handshake and status ────────────────────────────────────────────────────

test('handshake: start resolves, ready fires, version parsed from userAgent', async () => {
  const dir = makeDir({ appServer: { version: '7.7.7-test' } });
  const server = makeServer(dir);
  try {
    assert.strictEqual(server.isReady(), false);
    const readyP = once(server, 'ready', { signal: within(5000) });
    await server.start();
    const [ready] = await readyP;
    assert.strictEqual(server.isReady(), true);
    assert.strictEqual(server.version(), '7.7.7-test');
    assert.strictEqual(ready.version, '7.7.7-test');
    // The stub logged the handshake: clientInfo name is rundock and the
    // experimental surface is never opted into.
    const init = await waitForInvocation(dir, e => e.method === 'initialize');
    assert.strictEqual(init.params.clientInfo.name, 'rundock');
    assert.strictEqual(init.params.capabilities.experimentalApi, false);
    await waitForInvocation(dir, e => e.method === 'initialized');
  } finally {
    await server.shutdown();
  }
});

test('wire: the stub omits the jsonrpc field, like the real server, and the fixtures agree', async () => {
  // Raw protocol probe, bypassing the client: the tolerance the client needs
  // is only proven if the harness really reproduces the wire quirk
  // (RESEARCH.md section 1).
  const dir = makeDir();
  const proc = spawn(STUB_BIN, ['app-server'], { cwd: dir });
  try {
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: 'probe', version: '0' }, capabilities: { experimentalApi: false } } }) + '\n');
    const line = await new Promise((resolve, reject) => {
      let buf = '';
      proc.stdout.setEncoding('utf-8');
      proc.stdout.on('data', c => {
        buf += c;
        const i = buf.indexOf('\n');
        if (i >= 0) resolve(buf.slice(0, i));
      });
      proc.on('error', reject);
      setTimeout(() => reject(new Error('no response from stub')), 5000);
    });
    const msg = JSON.parse(line);
    assert.ok(!('jsonrpc' in msg), 'stub must omit the jsonrpc field, like the real server');
    assert.strictEqual(msg.id, 1);
    assert.ok(msg.result.userAgent.startsWith('probe/0.144.3'));
  } finally {
    proc.kill('SIGKILL');
  }
  // Every fixture envelope omits it too, so stub and tests cannot drift.
  const t = 'thr', u = 'turn', i = 'item';
  const envelopes = [
    asfx.response(1, {}), asfx.errorResponse(1, -32600, 'x'), asfx.overloadErrorResponse(1),
    asfx.unknownMethodError(1, 'no/such'), asfx.remoteControlStatusChanged(),
    asfx.threadStartedNotification(t), asfx.threadStatusChanged(t, 'active'), asfx.turnStarted(t, u),
    asfx.itemStartedUserMessage(t, u, i, 'x'), asfx.itemCompletedUserMessage(t, u, i, 'x'),
    asfx.itemStartedAgentMessage(t, u, i), asfx.agentMessageDelta(t, u, i, 'x'),
    asfx.itemCompletedAgentMessage(t, u, i, 'x'), asfx.itemStartedCommandExecution(t, u, i, 'ls'),
    asfx.itemStartedFileChange(t, u, i), asfx.tokenUsageUpdated(t, u), asfx.accountRateLimitsUpdated(),
    asfx.turnCompleted(t, u), asfx.errorNotification(t, u, {}),
    asfx.commandApprovalRequest(9, { threadId: t, turnId: u, itemId: i, command: 'ls' }),
    asfx.fileChangeApprovalRequest(9, { threadId: t, turnId: u, itemId: i }),
  ];
  for (const env of envelopes) {
    assert.ok(!('jsonrpc' in env), `fixture must omit jsonrpc: ${JSON.stringify(env).slice(0, 80)}`);
  }
});

// ── Thread lifecycle ────────────────────────────────────────────────────────

test('thread start and resume round-trip thread ids', async () => {
  const dir = makeDir({ appServer: {} });
  const server = makeServer(dir);
  try {
    await server.start();
    const { threadId } = await server.startThread({ cwd: dir, model: 'gpt-test' });
    assert.ok(typeof threadId === 'string' && threadId.length > 10);
    const resumed = await server.resumeThread(threadId);
    assert.strictEqual(resumed.threadId, threadId);
    const resume = readInvocations(dir).find(e => e.method === 'thread/resume');
    assert.strictEqual(resume.params.threadId, threadId);
  } finally {
    await server.shutdown();
  }
});

// ── Streaming turns ─────────────────────────────────────────────────────────

test('full streamed turn: deltas accumulate, completed text authoritative, usage attached to done', async () => {
  const dir = makeDir({
    appServer: {
      rules: [{
        match: { promptIncludes: 'hello' },
        deltas: ['Hel', 'lo ', 'world'],
        text: 'Hello world',
        usage: { inputTokens: 120, cachedInputTokens: 40, outputTokens: 9 },
      }],
    },
  });
  const server = makeServer(dir);
  try {
    await server.start();
    const { threadId } = await server.startThread({ cwd: dir });
    const sub = server.startTurn(threadId, 'say hello please');
    const events = record(sub);
    const done = await nextEvent(sub, 'done');
    const { turnId } = await sub.started;
    assert.ok(typeof turnId === 'string' && turnId.length > 10);
    assert.strictEqual(sub.turnId, turnId);

    const deltas = events.filter(e => e.type === 'delta').map(e => e.text);
    assert.strictEqual(deltas.join(''), 'Hello world', 'deltas accumulate to the full text');
    const text = events.find(e => e.type === 'text');
    assert.strictEqual(text.text, 'Hello world', 'completed item text is authoritative');

    // Usage rides thread/tokenUsage/updated BEFORE turn/completed
    // (RESEARCH.md section 6) and must be buffered onto done.
    const expectedUsage = { inputTokens: 120, cachedInputTokens: 40, outputTokens: 9, reasoningOutputTokens: 0 };
    const usageIdx = events.findIndex(e => e.type === 'usage');
    const doneIdx = events.findIndex(e => e.type === 'done');
    assert.ok(usageIdx >= 0 && usageIdx < doneIdx, 'usage event precedes done');
    assert.deepStrictEqual(events[usageIdx].usage, expectedUsage);
    assert.strictEqual(done.status, 'completed');
    assert.deepStrictEqual(done.usage, expectedUsage);
    assert.strictEqual(done.error, null);
    // The turn slot is free again.
    const sub2 = server.startTurn(threadId, 'say hello again');
    await nextEvent(sub2, 'done');
  } finally {
    await server.shutdown();
  }
});

test('default usage numbers come from the shared fixture when a rule omits usage', async () => {
  const dir = makeDir({ appServer: { rules: [{ match: { promptIncludes: 'plain' }, text: 'ok' }] } });
  const server = makeServer(dir);
  try {
    await server.start();
    const { threadId } = await server.startThread({ cwd: dir });
    const sub = server.startTurn(threadId, 'plain turn');
    const done = await nextEvent(sub, 'done');
    // Expectation derived FROM the fixture, not hardcoded: drift-proof.
    const last = asfx.tokenUsageUpdated('t', 'u').params.tokenUsage.last;
    assert.deepStrictEqual(done.usage, {
      inputTokens: last.inputTokens,
      cachedInputTokens: last.cachedInputTokens,
      outputTokens: last.outputTokens,
      reasoningOutputTokens: last.reasoningOutputTokens,
    });
  } finally {
    await server.shutdown();
  }
});

test('two threads interleave on one process and demux strictly by threadId', async () => {
  const dir = makeDir({
    appServer: {
      rules: [
        { match: { promptIncludes: 'ALPHA' }, deltas: ['a1 ', 'a2 ', 'a3'], text: 'a1 a2 a3', usage: { inputTokens: 10, outputTokens: 3 } },
        { match: { promptIncludes: 'BETA' }, deltas: ['b1 ', 'b2 ', 'b3'], text: 'b1 b2 b3', usage: { inputTokens: 20, outputTokens: 6 } },
      ],
    },
  });
  const server = makeServer(dir);
  try {
    await server.start();
    const [a, b] = await Promise.all([server.startThread({ cwd: dir }), server.startThread({ cwd: dir })]);
    assert.notStrictEqual(a.threadId, b.threadId);
    const subA = server.startTurn(a.threadId, 'run ALPHA');
    const subB = server.startTurn(b.threadId, 'run BETA');
    const evA = record(subA);
    const evB = record(subB);
    const [doneA, doneB] = await Promise.all([nextEvent(subA, 'done'), nextEvent(subB, 'done')]);
    assert.strictEqual(evA.filter(e => e.type === 'delta').map(e => e.text).join(''), 'a1 a2 a3');
    assert.strictEqual(evB.filter(e => e.type === 'delta').map(e => e.text).join(''), 'b1 b2 b3');
    assert.strictEqual(evA.find(e => e.type === 'text').text, 'a1 a2 a3');
    assert.strictEqual(evB.find(e => e.type === 'text').text, 'b1 b2 b3');
    assert.strictEqual(doneA.usage.inputTokens, 10);
    assert.strictEqual(doneB.usage.inputTokens, 20);
    assert.notStrictEqual(subA.turnId, subB.turnId);
  } finally {
    await server.shutdown();
  }
});

// ── Approvals ───────────────────────────────────────────────────────────────

const APPROVAL_SCENARIO = {
  appServer: {
    rules: [{
      match: { promptIncludes: 'escalate' },
      approval: {
        kind: 'command',
        command: 'rm -rf /tmp/x',
        reason: 'outside the sandbox',
        afterDecision: { accept: { text: 'command ran' }, decline: { text: 'command skipped' } },
      },
      usage: { inputTokens: 5, outputTokens: 2 },
    }],
  },
};

test('approval request: respond accept continues the turn; double respond is a no-op', async () => {
  const dir = makeDir(APPROVAL_SCENARIO);
  const server = makeServer(dir);
  try {
    await server.start();
    const { threadId } = await server.startThread({ cwd: dir });
    const sub = server.startTurn(threadId, 'please escalate');
    const events = record(sub);
    const approval = await nextEvent(sub, 'approval');
    assert.strictEqual(approval.kind, 'command');
    assert.strictEqual(approval.params.command, 'rm -rf /tmp/x');
    assert.strictEqual(approval.params.reason, 'outside the sandbox');
    assert.strictEqual(approval.params.threadId, threadId);
    assert.ok(Number.isInteger(approval.requestId));
    assert.throws(() => approval.respond('yes'), /invalid approval decision/);
    assert.strictEqual(approval.respond('accept'), true);
    assert.strictEqual(approval.respond('decline'), false, 'second respond is a no-op');
    const done = await nextEvent(sub, 'done');
    assert.strictEqual(done.status, 'completed');
    assert.strictEqual(events.find(e => e.type === 'text').text, 'command ran', 'the accept branch continued the turn');
    // The stub recorded exactly one decision: accept.
    const decisions = readInvocations(dir).filter(e => e.approvalDecision !== undefined);
    assert.deepStrictEqual(decisions.map(d => d.approvalDecision), ['accept']);
  } finally {
    await server.shutdown();
  }
});

test('approval decline path (fileChange kind) takes the decline branch', async () => {
  const dir = makeDir({
    appServer: {
      rules: [{
        match: { promptIncludes: 'patch' },
        approval: {
          kind: 'fileChange',
          grantRoot: '/etc',
          reason: 'writes outside writable roots',
          afterDecision: { accept: { text: 'patched' }, decline: { text: 'patch refused' } },
        },
      }],
    },
  });
  const server = makeServer(dir);
  try {
    await server.start();
    const { threadId } = await server.startThread({ cwd: dir });
    const sub = server.startTurn(threadId, 'apply the patch');
    const events = record(sub);
    const approval = await nextEvent(sub, 'approval');
    assert.strictEqual(approval.kind, 'fileChange');
    assert.strictEqual(approval.params.grantRoot, '/etc');
    approval.respond('decline');
    const done = await nextEvent(sub, 'done');
    assert.strictEqual(done.status, 'completed');
    assert.strictEqual(events.find(e => e.type === 'text').text, 'patch refused');
  } finally {
    await server.shutdown();
  }
});

test('approval cancel interrupts the turn', async () => {
  const dir = makeDir(APPROVAL_SCENARIO);
  const server = makeServer(dir);
  try {
    await server.start();
    const { threadId } = await server.startThread({ cwd: dir });
    const sub = server.startTurn(threadId, 'please escalate');
    const approval = await nextEvent(sub, 'approval');
    approval.respond('cancel');
    const done = await nextEvent(sub, 'done');
    assert.strictEqual(done.status, 'interrupted');
  } finally {
    await server.shutdown();
  }
});

test('unanswered approval auto-declines after approvalTimeoutMs so the turn never hangs', async () => {
  const dir = makeDir(APPROVAL_SCENARIO);
  const server = makeServer(dir, { approvalTimeoutMs: 100 });
  try {
    await server.start();
    const { threadId } = await server.startThread({ cwd: dir });
    const sub = server.startTurn(threadId, 'please escalate');
    const events = record(sub);
    const approval = await nextEvent(sub, 'approval');
    // Nobody responds. The default-decision timer must unblock the server.
    const done = await nextEvent(sub, 'done');
    assert.strictEqual(done.status, 'completed');
    assert.strictEqual(events.find(e => e.type === 'text').text, 'command skipped');
    // Late respond after the timeout already answered: no-op.
    assert.strictEqual(approval.respond('accept'), false);
    const decisions = readInvocations(dir).filter(e => e.approvalDecision !== undefined);
    assert.deepStrictEqual(decisions.map(d => d.approvalDecision), ['decline']);
  } finally {
    await server.shutdown();
  }
});

// ── Turn errors ─────────────────────────────────────────────────────────────

test('turn errors classify by codexErrorInfo: quota, auth, context, model', async () => {
  const cases = [
    { tag: 'QUOTA', info: 'usageLimitExceeded', message: "You've hit your usage limit.", willRetry: false, kind: 'quota' },
    { tag: 'AUTH', info: 'unauthorized', message: 'Not signed in.', willRetry: false, kind: 'auth' },
    { tag: 'CONTEXT', info: 'contextWindowExceeded', message: 'Context window exceeded.', willRetry: true, kind: 'context' },
    { tag: 'MODEL', info: 'badRequest', message: "The 'gpt-x' model is not supported when using Codex with a ChatGPT account.", willRetry: false, kind: 'model' },
    { tag: 'BADREQ', info: 'badRequest', message: 'Malformed input.', willRetry: false, kind: 'unknown' },
  ];
  const dir = makeDir({
    appServer: {
      rules: cases.map(c => ({
        match: { promptIncludes: c.tag },
        error: { codexErrorInfo: c.info, message: c.message, willRetry: c.willRetry },
      })),
    },
  });
  const server = makeServer(dir);
  try {
    await server.start();
    for (const c of cases) {
      const { threadId } = await server.startThread({ cwd: dir });
      const sub = server.startTurn(threadId, `trigger ${c.tag}`);
      const errP = nextEvent(sub, 'error');
      const done = await nextEvent(sub, 'done');
      const err = await errP;
      assert.strictEqual(err.kind, c.kind, `${c.tag} classifies as ${c.kind}`);
      assert.strictEqual(err.message, c.message);
      assert.strictEqual(err.willRetry, c.willRetry);
      assert.strictEqual(done.status, 'failed');
      assert.strictEqual(done.error.message, c.message);
    }
  } finally {
    await server.shutdown();
  }
});

test('normalizeErrorKind: object-form codexErrorInfo variants stay unknown', () => {
  assert.strictEqual(normalizeErrorKind({ httpConnectionFailed: { httpStatusCode: 502 } }, 'boom'), 'unknown');
  assert.strictEqual(normalizeErrorKind('sessionBudgetExceeded', ''), 'quota');
  assert.strictEqual(normalizeErrorKind(null, 'anything'), 'unknown');
  assert.strictEqual(parseUserAgentVersion('rundock/0.144.3 (Mac OS 26.4.1; arm64)'), '0.144.3');
  assert.strictEqual(parseUserAgentVersion(''), null);
});

// ── Interrupt and turn exclusivity ──────────────────────────────────────────

test('interrupt mid-turn: done arrives with status interrupted', async () => {
  const dir = makeDir({
    appServer: { rules: [{ match: { promptIncludes: 'hang' }, deltas: ['working...'], hangAfterDeltas: true }] },
  });
  const server = makeServer(dir);
  try {
    await server.start();
    const { threadId } = await server.startThread({ cwd: dir });
    const sub = server.startTurn(threadId, 'hang forever');
    await nextEvent(sub, 'delta');
    const { turnId } = await sub.started;
    // Subscribe BEFORE interrupting: the interrupt response and the
    // follow-up turn/completed can arrive in one pipe chunk, in which case
    // the done event fires synchronously before an await continuation runs.
    const doneP = nextEvent(sub, 'done');
    await server.interruptTurn(threadId, turnId);
    const done = await doneP;
    assert.strictEqual(done.status, 'interrupted');
    assert.strictEqual(done.error, null, 'interrupted is done-with-flag, not an error');
  } finally {
    await server.shutdown();
  }
});

test('second startTurn on a thread with an active turn fails fast client-side', async () => {
  const dir = makeDir({
    appServer: { rules: [{ match: { promptIncludes: 'hang' }, deltas: ['busy'], hangAfterDeltas: true }] },
  });
  const server = makeServer(dir);
  try {
    await server.start();
    const { threadId } = await server.startThread({ cwd: dir });
    const sub = server.startTurn(threadId, 'hang forever');
    await nextEvent(sub, 'delta');
    assert.throws(() => server.startTurn(threadId, 'me too'), /already active/);
    // interruptTurn without an explicit turnId uses the tracked one.
    // (Subscribe before interrupting; see the interrupt mid-turn test.)
    const doneP = nextEvent(sub, 'done');
    await server.interruptTurn(threadId);
    const done = await doneP;
    assert.strictEqual(done.status, 'interrupted');
    // The slot is free again after completion.
    const sub2 = server.startTurn(threadId, 'plain follow-up');
    await nextEvent(sub2, 'done');
  } finally {
    await server.shutdown();
  }
});

// ── Request-level failure modes ─────────────────────────────────────────────

test('request timeout rejects when the server never answers', async () => {
  const dir = makeDir({ appServer: { dropMethods: ['thread/resume'] } });
  const server = makeServer(dir);
  try {
    await server.start();
    // Per-request override rather than a client-wide 100ms: the handshake
    // must not race a slow spawn under load.
    await assert.rejects(
      server.request('thread/resume', { threadId: '019f0000-aaaa-7000-b000-c00000000001' }, { timeoutMs: 100 }),
      /timed out after 100ms: thread\/resume/
    );
    // The connection is still usable afterwards.
    const { threadId } = await server.startThread({ cwd: dir });
    assert.ok(threadId);
  } finally {
    await server.shutdown();
  }
});

test('overload -32001 responses are retried with backoff until they clear', async () => {
  const dir = makeDir({ appServer: { overload: { method: 'thread/start', times: 2 } } });
  const server = makeServer(dir); // 3 attempts of retry allowed
  try {
    await server.start();
    const { threadId } = await server.startThread({ cwd: dir });
    assert.ok(threadId, 'succeeds on the retry after two overload rejections');
    const attempts = readInvocations(dir).filter(e => e.method === 'thread/start');
    assert.strictEqual(attempts.length, 3, 'two rejected attempts plus the success');
  } finally {
    await server.shutdown();
  }
});

test('overload retries are bounded: persistent overload surfaces the -32001 error', async () => {
  const dir = makeDir({ appServer: { overload: { method: 'thread/start', times: 99 } } });
  const server = makeServer(dir, { overloadRetry: { attempts: 1, baseMs: 5, maxMs: 10 } });
  try {
    await server.start();
    await assert.rejects(server.startThread({ cwd: dir }), /overloaded/i);
    const attempts = readInvocations(dir).filter(e => e.method === 'thread/start');
    assert.strictEqual(attempts.length, 2, 'initial attempt plus the single bounded retry');
  } finally {
    await server.shutdown();
  }
});

// ── Crash, restart, resilience ──────────────────────────────────────────────

test('process crash mid-turn: turn errors, exit fires, restart backs off, server recovers', async () => {
  const dir = makeDir({
    appServer: { rules: [{ match: { promptIncludes: 'boom' }, deltas: ['about to die'], crashMidTurn: true }] },
  });
  const server = makeServer(dir);
  try {
    await server.start();
    const { threadId } = await server.startThread({ cwd: dir });
    const exitP = once(server, 'exit', { signal: within(5000) });
    const restartP = once(server, 'restart', { signal: within(5000) });
    const sub = server.startTurn(threadId, 'go boom');
    const events = record(sub);
    const done = await nextEvent(sub, 'done');
    assert.strictEqual(done.status, 'failed');
    assert.match(done.error.message, /exited mid-turn/);
    const err = events.find(e => e.type === 'error');
    assert.match(err.message, /exited mid-turn/);
    const [exit] = await exitP;
    assert.strictEqual(exit.intentional, false);
    const [restart] = await restartP;
    assert.strictEqual(restart.attempt, 1);
    assert.strictEqual(restart.delayMs, 25, 'first backoff step is the injected base');
    // Auto-restart completes a fresh handshake and the server is usable again.
    await once(server, 'ready', { signal: within(5000) });
    assert.strictEqual(server.isReady(), true);
    const again = await server.startThread({ cwd: dir });
    assert.ok(again.threadId);
    const sub2 = server.startTurn(again.threadId, 'plain turn after restart');
    const done2 = await nextEvent(sub2, 'done');
    assert.strictEqual(done2.status, 'completed');
  } finally {
    await server.shutdown();
  }
});

test('malformed lines, unknown notifications and unguarded deltas are skipped without breaking the turn', async () => {
  const dir = makeDir({
    appServer: { rules: [{ match: { promptIncludes: 'noisy' }, noise: true, deltas: ['ok'], text: 'ok done' }] },
  });
  const server = makeServer(dir);
  try {
    await server.start();
    const { threadId } = await server.startThread({ cwd: dir });
    const sub = server.startTurn(threadId, 'noisy turn');
    const events = record(sub);
    const done = await nextEvent(sub, 'done');
    assert.strictEqual(done.status, 'completed');
    const deltas = events.filter(e => e.type === 'delta').map(e => e.text);
    assert.deepStrictEqual(deltas, ['ok'], 'the ghost delta for an unannounced item is dropped');
    assert.strictEqual(events.find(e => e.type === 'text').text, 'ok done');
  } finally {
    await server.shutdown();
  }
});

// ── Policy invariants ───────────────────────────────────────────────────────

test('policy invariants: no danger-full-access, reviewer always user, experimentalApi false, no approvalPolicy default', async () => {
  const dir = makeDir({ appServer: {} });
  const server = makeServer(dir);
  try {
    await server.start();
    const { threadId } = await server.startThread({ cwd: dir, model: 'gpt-test', sandbox: 'workspace-write' });
    await server.startThread({ cwd: dir, approvalPolicy: 'never' }); // explicit caller opt-in

    // danger-full-access is refused client-side, before anything hits the wire.
    await assert.rejects(server.startThread({ cwd: dir, sandbox: 'danger-full-access' }), /danger-full-access/);
    await assert.rejects(server.resumeThread(threadId, { sandbox: 'danger-full-access' }), /danger-full-access/);
    assert.throws(
      () => server.startTurn(threadId, 'x', { sandboxPolicy: { type: 'dangerFullAccess' } }),
      /dangerFullAccess/
    );

    const inv = readInvocations(dir);
    const init = inv.find(e => e.method === 'initialize');
    assert.strictEqual(init.params.capabilities.experimentalApi, false, 'experimentalApi always false');

    const starts = inv.filter(e => e.method === 'thread/start');
    assert.strictEqual(starts.length, 2, 'the refused danger-full-access call never reached the stub');
    for (const s of starts) {
      assert.strictEqual(s.params.approvalsReviewer, 'user', 'approvalsReviewer always user');
      assert.notStrictEqual(s.params.sandbox, 'danger-full-access');
    }
    // approvalPolicy is pass-through only: absent unless the caller sets it.
    assert.ok(!('approvalPolicy' in starts[0].params), 'no approvalPolicy default');
    assert.strictEqual(starts[1].params.approvalPolicy, 'never', 'explicit never passes through');

    // Belt and braces: the forbidden mode appears nowhere in anything sent.
    for (const entry of inv) {
      assert.ok(!JSON.stringify(entry).includes('danger-full-access') || entry.method !== 'thread/start');
    }
  } finally {
    await server.shutdown();
  }
});

// ── Clean shutdown ──────────────────────────────────────────────────────────

test('shutdown interrupts active turns, terminates the process, and never restarts', async () => {
  const dir = makeDir({
    appServer: { rules: [{ match: { promptIncludes: 'hang' }, deltas: ['busy'], hangAfterDeltas: true }] },
  });
  const logs = [];
  const server = makeServer(dir, { log: m => logs.push(m) });
  await server.start();
  const { threadId } = await server.startThread({ cwd: dir });
  const sub = server.startTurn(threadId, 'hang forever');
  await nextEvent(sub, 'delta');
  await sub.started;

  let restarted = false;
  server.on('restart', () => { restarted = true; });
  const exitP = once(server, 'exit', { signal: within(5000) });
  const doneP = nextEvent(sub, 'done');
  await server.shutdown();
  const [exit] = await exitP;
  assert.strictEqual(exit.intentional, true);
  const done = await doneP;
  const diag = `logs=${JSON.stringify(logs)} inv=${JSON.stringify(readInvocations(dir).map(i => i.method || i.event || 'resp'))}`;
  assert.strictEqual(done.status, 'interrupted', `the active turn was interrupted, not abandoned (${diag})`);
  assert.ok(readInvocations(dir).some(e => e.method === 'turn/interrupt'), 'turn/interrupt sent before SIGTERM');
  assert.strictEqual(server.isReady(), false);
  await new Promise(r => setTimeout(r, 150));
  assert.strictEqual(restarted, false, 'no auto-restart after an intentional shutdown');
  await assert.rejects(server.start(), /shut down/);
});
