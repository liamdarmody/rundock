'use strict';
// Characterization: wireProcessHandlers, the shared stdout/stderr pipeline for
// every Claude Code process. Uses the SHARED stream-json fixtures
// (test/fixtures/stream-json.js) that also drive the stub claude binary.
const { test, describe, beforeEach, after } = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');

const { _internal: srv } = require('../../server.js');
const fx = require('../fixtures/stream-json.js');
const { makeWorkspace, standardTeam, cleanup } = require('../helpers/workspace.js');

after(cleanup);

// Fake child process: lets tests push stdout/stderr chunks synchronously.
function fakeProcess() {
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.killed = false;
  proc.kill = () => { proc.killed = true; };
  proc.stdin = { writable: true, write: () => true };
  return proc;
}

function makeEntry(overrides = {}) {
  return {
    process: fakeProcess(), buffer: '', processId: 'proc-1', agentId: 'lead-designer',
    responseText: '', exited: false, resultSent: false,
    pendingAgentTool: null, toolCalls: [], turnStartTime: Date.now(),
    ...overrides,
  };
}

// Capture everything safeSend emits by registering a fake WS client.
let captured;
const fakeClient = { readyState: 1, send: (payload) => captured.push(JSON.parse(payload)) };

beforeEach(() => {
  captured = [];
  srv.connectedClients.clear();
  srv.connectedClients.add(fakeClient);
  srv.disconnectBuffer.length = 0;
  srv.convoTranscripts.clear();
});

function push(entry, events) {
  entry.process.stdout.emit('data', Buffer.from(fx.toLines(events)));
}

describe('stdout JSONL parsing', () => {
  test('parses complete lines, enriches with _agent/_conversationId/_processId', () => {
    const entry = makeEntry();
    srv.wireProcessHandlers(entry, 'convo-1', null, {});
    push(entry, [fx.init('sess-1')]);
    assert.strictEqual(captured.length, 1);
    assert.strictEqual(captured[0]._agent, 'lead-designer');
    assert.strictEqual(captured[0]._conversationId, 'convo-1');
    assert.strictEqual(captured[0]._processId, 'proc-1');
  });

  test('init message captures session id onto the entry and the message', () => {
    const entry = makeEntry();
    srv.wireProcessHandlers(entry, 'convo-1', null, {});
    push(entry, [fx.init('sess-42')]);
    assert.strictEqual(entry.sessionId, 'sess-42');
    assert.strictEqual(captured[0]._sessionId, 'sess-42');
  });

  test('a line split across two chunks is buffered and parsed once complete', () => {
    const entry = makeEntry();
    srv.wireProcessHandlers(entry, 'convo-1', null, {});
    const line = JSON.stringify(fx.init('sess-x')) + '\n';
    entry.process.stdout.emit('data', Buffer.from(line.slice(0, 10)));
    assert.strictEqual(captured.length, 0, 'incomplete line held in buffer');
    entry.process.stdout.emit('data', Buffer.from(line.slice(10)));
    assert.strictEqual(captured.length, 1);
    assert.strictEqual(entry.sessionId, 'sess-x');
  });

  test('non-JSON lines are forwarded as raw messages', () => {
    const entry = makeEntry();
    srv.wireProcessHandlers(entry, 'convo-1', null, {});
    entry.process.stdout.emit('data', Buffer.from('not json at all\n'));
    assert.strictEqual(captured[0].type, 'raw');
    assert.strictEqual(captured[0].content, 'not json at all');
  });

  test('exited guard: chunks arriving after entry.exited are dropped entirely', () => {
    const entry = makeEntry({ exited: true });
    srv.wireProcessHandlers(entry, 'convo-1', null, {});
    push(entry, [fx.init('sess-1')]);
    assert.strictEqual(captured.length, 0);
  });
});

describe('response text accumulation', () => {
  test('text deltas accumulate into responseText', () => {
    const entry = makeEntry();
    srv.wireProcessHandlers(entry, 'convo-1', null, {});
    push(entry, [fx.textDelta('Hello '), fx.textDelta('world')]);
    assert.strictEqual(entry.responseText, 'Hello world');
  });

  test('a later assistant message does not clobber an earlier block (marker survives)', () => {
    // Post-fix behavior: the assistant message appends (deduped against the
    // delta stream) instead of replacing, so a marker streamed earlier in the
    // turn is retained. Regression companion in regression.test.js.
    const entry = makeEntry();
    srv.wireProcessHandlers(entry, 'convo-1', null, {});
    push(entry, [
      fx.textDelta(`Work done. ${fx.MARKERS.COMPLETE}`),
      fx.assistantMessage(`Work done. ${fx.MARKERS.COMPLETE}`),
      fx.textDelta(' Anything else?'),
      fx.assistantMessage('Anything else?'),
    ]);
    assert.strictEqual(entry.responseText, `Work done. ${fx.MARKERS.COMPLETE} Anything else?`);
    assert.ok(entry.responseText.includes(fx.MARKERS.COMPLETE), 'marker retained');
  });

  test('assistant message does not double-count text already accumulated from deltas', () => {
    // Guards the dedup: a normal turn (deltas then the reconciling assistant
    // message with identical text) leaves responseText equal to the text once.
    const entry = makeEntry();
    srv.wireProcessHandlers(entry, 'convo-1', null, {});
    push(entry, [fx.textDelta('Hello '), fx.textDelta('world'), fx.assistantMessage('Hello world')]);
    assert.strictEqual(entry.responseText, 'Hello world');
  });

  test('a multi-text-block assistant message after deltas does not duplicate text', () => {
    // Repro of the duplication regression: the delta stream concatenates the two
    // blocks ("AB"), then the assistant message carries them as SEPARATE text blocks.
    // The old per-block endsWith check appended A then B onto "AB" -> "ABAB".
    // Post-fix, deltas are authoritative and the assistant message is skipped
    // when deltas ran, so each block appears exactly once and the marker (in the
    // first block) survives.
    const entry = makeEntry();
    srv.wireProcessHandlers(entry, 'convo-1', null, {});
    const blockA = `First block ${fx.MARKERS.COMPLETE} `;
    const blockB = 'second block';
    push(entry, [
      fx.textDelta(blockA + blockB),                         // deltas accumulate "AB"
      fx.assistantMessage(blockA, [{ type: 'text', text: blockB }]), // two text blocks
    ]);
    assert.strictEqual(entry.responseText, blockA + blockB, 'both blocks present exactly once (no ABAB duplication)');
    assert.ok(entry.responseText.includes(fx.MARKERS.COMPLETE), 'marker in the first block survives');
  });

  test('with NO deltas the assistant message blocks are the fallback source', () => {
    // A turn that emits only an assistant message (no partial deltas) still
    // populates responseText from every text block. The sawTextDelta flag is
    // reset per turn (in the result handler), so a no-delta turn falls back
    // correctly even after an earlier delta turn on the same process.
    const entry = makeEntry();
    srv.wireProcessHandlers(entry, 'convo-1', null, {});
    // First turn: deltas + result (flips and then resets sawTextDelta).
    push(entry, [fx.textDelta('turn one'), fx.result({ text: 'turn one' })]);
    entry.responseText = '';
    // Second turn: assistant message only, two blocks, no deltas.
    push(entry, [fx.assistantMessage('alpha ', [{ type: 'text', text: 'beta' }])]);
    assert.strictEqual(entry.responseText, 'alpha beta', 'no-delta turn falls back to the assistant blocks');
  });
});

describe('tool call tracking', () => {
  test('tool_use blocks are tracked and first argument extracted for known tools', () => {
    const entry = makeEntry();
    srv.wireProcessHandlers(entry, 'convo-1', null, {});
    push(entry, fx.toolUseFlow('Read', { file_path: '/tmp/notes.md' }));
    push(entry, fx.toolUseFlow('Bash', { command: 'ls -la some/dir' }, 2));
    assert.strictEqual(entry.toolCalls.length, 2);
    assert.deepStrictEqual(entry.toolCalls.map(t => t.tool), ['Read', 'Bash']);
    assert.strictEqual(entry.toolCalls[0].arg, '/tmp/notes.md');
    assert.strictEqual(entry.toolCalls[1].arg, 'ls -la some/dir');
  });

  test('unknown tools are tracked without arg extraction', () => {
    const entry = makeEntry();
    srv.wireProcessHandlers(entry, 'convo-1', null, {});
    push(entry, fx.toolUseFlow('Skill', { skill: 'design-content' }));
    assert.strictEqual(entry.toolCalls.length, 1);
    assert.strictEqual(entry.toolCalls[0].arg, null);
  });

  test('interception disabled: Agent tool_use events flow through untouched', () => {
    const entry = makeEntry();
    srv.wireProcessHandlers(entry, 'convo-1', null, { enableInterception: false });
    push(entry, fx.toolUseFlow('Agent', { subagent_type: 'content-lead', prompt: 'hooks' }));
    assert.ok(!entry.process.killed, 'no interception kill');
    assert.strictEqual(captured.filter(m => m.type === 'stream_event').length, 4);
  });

  test('interception enabled but agent has no matching direct report: no kill, events forwarded', () => {
    srv.setWorkspace(makeWorkspace({ agents: standardTeam() }));
    const entry = makeEntry({ agentId: 'lead-designer' }); // Des has no reports
    srv.wireProcessHandlers(entry, 'convo-1', null, { enableInterception: true });
    push(entry, fx.toolUseFlow('Agent', { subagent_type: 'nonexistent', prompt: 'no teammate names here' }));
    assert.ok(!entry.process.killed);
    assert.strictEqual(entry.pendingAgentTool, null, 'pending state cleared');
  });
});

describe('result handling', () => {
  test('result marks resultSent, attaches tool calls, sends result then done, and fires onResult', () => {
    const entry = makeEntry();
    let onResultArgs = null;
    srv.wireProcessHandlers(entry, 'convo-1', null, { onResult: (e, parsed) => { onResultArgs = { e, parsed }; } });
    push(entry, fx.toolUseFlow('Read', { file_path: 'a.md' }));
    push(entry, [fx.result({ text: 'done' })]);
    assert.strictEqual(entry.resultSent, true);
    const resultMsg = captured.find(m => m.type === 'result');
    assert.deepStrictEqual(resultMsg._toolCalls.map(t => t.tool), ['Read']);
    assert.strictEqual(resultMsg._turnStartTime, entry.turnStartTime);
    const doneMsg = captured.find(m => m.type === 'system' && m.subtype === 'done');
    assert.ok(doneMsg, 'done follows result');
    assert.strictEqual(doneMsg.code, 0);
    assert.ok(captured.indexOf(resultMsg) < captured.indexOf(doneMsg));
    assert.strictEqual(onResultArgs.e, entry);
    assert.strictEqual(onResultArgs.parsed.type, 'result');
  });

  test('error result with auth signature sends the auth_error recovery card exactly once', () => {
    const entry = makeEntry();
    srv.wireProcessHandlers(entry, 'convo-1', null, {});
    push(entry, [fx.result({ text: 'authentication_error: OAuth token has expired', isError: true })]);
    push(entry, [fx.result({ text: 'authentication_error again', isError: true })]);
    const authCards = captured.filter(m => m.type === 'system' && m.subtype === 'auth_error');
    assert.strictEqual(authCards.length, 1);
  });

  test('error result with model signature sends the model-error message', () => {
    const entry = makeEntry();
    srv.wireProcessHandlers(entry, 'convo-1', null, {});
    push(entry, [fx.result({ text: 'There is an issue with the selected model', isError: true })]);
    const errs = captured.filter(m => m.type === 'error' && /model/.test(m.content));
    assert.strictEqual(errs.length, 1);
  });
});

describe('stderr handling', () => {
  test('plain stderr is forwarded as an error message', () => {
    const entry = makeEntry();
    srv.wireProcessHandlers(entry, 'convo-1', null, {});
    entry.process.stderr.emit('data', Buffer.from('something broke\n'));
    const errs = captured.filter(m => m.type === 'error');
    assert.strictEqual(errs.length, 1);
    assert.strictEqual(errs[0].content, 'something broke\n');
  });

  test('noise lines ("no stdin data", "proceeding without") are filtered', () => {
    const entry = makeEntry();
    srv.wireProcessHandlers(entry, 'convo-1', null, {});
    entry.process.stderr.emit('data', Buffer.from('no stdin data\n'));
    entry.process.stderr.emit('data', Buffer.from('proceeding without input\n'));
    assert.strictEqual(captured.length, 0);
  });

  test('auth-error stderr shows the recovery card once instead of the raw blob', () => {
    const entry = makeEntry();
    srv.wireProcessHandlers(entry, 'convo-1', null, {});
    entry.process.stderr.emit('data', Buffer.from('oauth token expired\n'));
    const authCards = captured.filter(m => m.type === 'system' && m.subtype === 'auth_error');
    assert.strictEqual(authCards.length, 1);
    assert.strictEqual(captured.filter(m => m.type === 'error').length, 0, 'raw blob suppressed');
  });

  test('after an auth-signature chunk, a later UNRELATED stderr still surfaces', () => {
    // Post-fix: stderrBuf resets after a match, so the accumulated auth text no
    // longer short-circuits every later chunk. The auth card stays single via
    // authErrorSent. Regression companion in regression.test.js.
    const entry = makeEntry();
    srv.wireProcessHandlers(entry, 'convo-1', null, {});
    entry.process.stderr.emit('data', Buffer.from('oauth token expired\n'));
    entry.process.stderr.emit('data', Buffer.from('TypeError: cannot read properties of undefined\n'));
    assert.strictEqual(captured.filter(m => m.type === 'system' && m.subtype === 'auth_error').length, 1, 'auth card once');
    assert.ok(captured.some(m => m.type === 'error' && /TypeError/.test(m.content || '')), 'later distinct error surfaces');
  });
});

describe('safeSend buffering', () => {
  test('disconnectBuffer is a newest-500 ring so terminal signals survive when full', () => {
    srv.connectedClients.clear();
    const entry = makeEntry();
    srv.wireProcessHandlers(entry, 'convo-1', null, {});
    push(entry, [fx.init('sess-1')]);
    assert.strictEqual(srv.disconnectBuffer.length, 1);
    // once full, the OLDEST is dropped and the newest terminal signal is kept
    srv.disconnectBuffer.length = 0;
    for (let i = 0; i < 500; i++) srv.disconnectBuffer.push(`old-${i}`);
    push(entry, [fx.result({ text: 'terminal' })]);
    assert.strictEqual(srv.disconnectBuffer.length, 500, 'cap held at 500');
    assert.ok(srv.disconnectBuffer.some(p => p.includes('"type":"result"')), 'terminal signal retained when buffer full');
    assert.ok(!srv.disconnectBuffer.includes('old-0'), 'oldest message evicted');
  });
});
