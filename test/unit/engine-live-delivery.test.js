'use strict';
// WHAT ACTUALLY REACHES THE SOCKET when a turn ends, measured rather than read.
//
// Every wrong answer in this card came from reading the engine and reasoning
// about whether a turn would be delivered. Four times. The sites are guarded by
// conditions spread across a thousand lines, the delivery routes are three and
// not obviously enumerable, and the question "does this turn reach a client"
// simply cannot be answered by looking.
//
// So this drives the real wireProcessHandlers over a real stdout stream with a
// fake process, injects safeSend and appendTranscript, and reports what each
// one received. It is the affordance the rest of the release kept discovering
// it did not have.
const { test, describe } = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const engineLib = require(path.join(ROOT, 'lib', 'delegation', 'engine.js'));

// A process the engine can wire: stdout and stderr it can listen to, a stdin it
// believes is writable, and the close/exit surface it expects.
function fakeProcess() {
  const p = new EventEmitter();
  p.stdout = new EventEmitter();
  p.stderr = new EventEmitter();
  p.stdin = { writable: true, write() {}, end() {} };
  p.killed = false;
  p.pid = 4242;
  p.kill = () => { p.killed = true; };
  return p;
}

// The runtime's own wire shapes, written out rather than imported, so a change
// to the fixtures cannot quietly change what this claims to have measured.
const wire = {
  textDelta: (text) => ({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } }),
  assistantText: (text) => ({ type: 'assistant', message: { content: [{ type: 'text', text }] } }),
  messageStop: () => ({ type: 'stream_event', event: { type: 'message_stop' } }),
  result: (text) => ({ type: 'result', subtype: 'success', result: text, session_id: 's1' }),
};

function harness({ agentId = 'default', interception = false } = {}) {
  const sent = [];
  const appended = [];
  const deps = {};
  for (const name of engineLib.DEP_NAMES) deps[name] = () => {};
  deps.processes = new Map();
  deps.MAX_CONSECUTIVE_AGENT_RESUMES = 3;
  deps.RESTORE_DELAY_MS = 0;
  deps.safeSend = (payload) => { try { sent.push(JSON.parse(payload)); } catch (e) { sent.push({ unparsed: payload }); } };
  deps.appendTranscript = (convoId, role, agent, text, type) => appended.push({ role, agent, text, type });
  deps.isSilentParkResponse = () => false;
  deps.discoverAgents = () => ([
    { id: 'default', name: 'roo', displayName: 'Roo', type: 'orchestrator' },
    { id: 'vox', name: 'vox', displayName: 'Vox', type: 'specialist', reportsTo: 'roo' },
  ]);

  const engine = engineLib.createDelegationEngine(deps);
  const proc = fakeProcess();
  const entry = {
    process: proc, agentId, processId: 'p1', runtime: 'claude',
    buffer: '', responseText: '', toolCalls: [], exited: false,
    pendingAgentTools: [], deliveredTurns: [],
  };
  deps.processes.set('c1', entry);
  engine.wireProcessHandlers(entry, 'c1', null, { enableInterception: interception });

  const emit = (...objs) => {
    for (const o of objs) proc.stdout.emit('data', Buffer.from(JSON.stringify(o) + '\n'));
  };
  return { sent, appended, emit, entry, proc };
}

describe('a turn that streamed nothing still reaches the socket', () => {
  test('text arriving only in the assistant envelope is forwarded in the result', () => {
    // THE CASE THE WHOLE DELTA ARGUMENT WAS ABOUT. responseText is filled from
    // the assistant message because no deltas arrived, so the client built no
    // bubble from streaming. If nothing carrying that text reaches the socket,
    // the turn is invisible until a reload. This measures which it is.
    const h = harness();
    h.emit(wire.assistantText('The answer, with no deltas at all.'));
    h.emit(wire.messageStop());
    h.emit(wire.result('The answer, with no deltas at all.'));

    assert.strictEqual(h.entry.sawTextDelta, false,
      'sanity: this turn genuinely streamed no deltas, or it is not the case under test');
    assert.strictEqual(h.entry.responseText, 'The answer, with no deltas at all.',
      'sanity: and the text was accumulated from the envelope, which is the case under test');

    const carrying = h.sent.filter((m) => JSON.stringify(m).includes('The answer, with no deltas at all.'));
    assert.ok(carrying.length > 0,
      'a turn the client never streamed has to reach it somehow, or it is invisible until reload. '
      + `What reached the socket: ${JSON.stringify(h.sent.map((m) => m.type + '/' + (m.subtype || '')))}`);
    // MEASURED: the engine forwards the raw stream wholesale, so both the
    // assistant envelope and the result carry it. This is the finding that
    // closes the class: a turn is delivered by default, and only a branch that
    // SUPPRESSES the envelope can make one invisible.
    assert.deepStrictEqual(carrying.map((m) => m.type).sort(), ['assistant', 'result'],
      'the whole envelope is forwarded, not merely the result');
  });

  test('a turn that did stream is still forwarded exactly once', () => {
    const h = harness();
    h.emit(wire.textDelta('Streamed '), wire.textDelta('in pieces.'));
    // CHECKED BEFORE THE RESULT. The result handler resets sawTextDelta for the
    // next turn, so asserting it afterwards reads false for a turn that did
    // stream: a fact about the flag's lifetime, not about the turn.
    assert.strictEqual(h.entry.sawTextDelta, true, 'sanity: this turn did stream');
    h.emit(wire.messageStop());
    h.emit(wire.result('Streamed in pieces.'));
    const results = h.sent.filter((m) => m.type === 'result');
    assert.strictEqual(results.length, 1, 'one result, not one per block');
    assert.ok(h.sent.some((m) => JSON.stringify(m).includes('Streamed in pieces.')),
      'and the text is on the socket, as it is for every turn the engine does not suppress');
  });

  test('the engine forwards the envelope as it arrives, so delivery is the default', () => {
    // THE FINDING THAT CLOSES THE CLASS, stated as the assertion it came from.
    //
    // Four rounds of this card argued about which append sites deliver their
    // turn and which do not, and enumerated exceptions for the ones that could
    // not be settled by reading. The answer is that the engine forwards every
    // runtime line to the socket as it arrives, so a turn is delivered by
    // default and no append site has to arrange it. What can make a turn
    // invisible is a branch that SUPPRESSES the envelope, and there is exactly
    // one: the Agent-tool interception, which suppresses the end-of-message
    // envelope and kills the process so the delegate can take over. That is
    // the branch this card fixes, and it is the whole class.
    const h = harness();
    h.emit(wire.assistantText('Forwarded the moment it arrived.'));

    const carrying = h.sent.filter((m) => JSON.stringify(m).includes('Forwarded the moment it arrived.'));
    assert.ok(carrying.length > 0,
      'the line is on the socket before any result, close or append has happened');
    assert.strictEqual(h.appended.length, 0,
      'and before anything was written to the transcript, which is what makes the two independent');
  });

  test('suppressing the envelope is what makes a turn invisible, and only that', () => {
    // The other direction: with nothing emitted for the turn, nothing carries
    // it. This is the shape the interception creates, and the reason the
    // handoff line had to be sent explicitly rather than left to the stream.
    const h = harness();
    h.entry.responseText = 'Accumulated but never emitted.';
    h.proc.emit('close', 0);

    const carrying = h.sent.filter((m) => JSON.stringify(m).includes('Accumulated but never emitted.'));
    assert.deepStrictEqual(carrying, [],
      'a turn whose envelope never reached the socket is invisible, whatever the transcript holds');
  });
});
// The interception itself is NOT driven here. It resolves its target through
// discoverAgents, which this module imports directly rather than taking as a
// dep, so matching a direct report needs a real workspace on disk. That is the
// integration harness's job, and the assertion lives in
// test/integration/handoff-line.test.js where a real delegation already runs.
