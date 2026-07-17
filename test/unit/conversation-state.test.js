'use strict';
// Unit tests for public/conversation-state.js: the per-conversation state
// machine extracted from app.js's WebSocket handlers. Every behaviour here is
// the extraction contract: a failure means the refactor changed behaviour,
// which is a defect by definition.
//
// The replay harness mirrors app.js's glue exactly: it feeds each fixture
// message through reduce() with the same ctx facts the glue builds (including
// the marker-scan half of handleResult that decides delegationTriggered), and
// executes session effects against a tiny conversation model so later init
// decisions see accumulated facts.
const { test } = require('node:test');
const assert = require('node:assert');

const { createState, reduce, isStale } = require('../../public/conversation-state.js');
const { scanMarkers } = require('../../public/markers.js');
const seq = require('../fixtures/orchestration-sequences.js');

const AGENT_TYPES = { cos: 'orchestrator', dev: 'specialist' };

function buildCtx(msg, state, convo, { isActive, viewingChat }) {
  if (msg.type === 'system' && msg.subtype === 'init') {
    return {
      convoExists: true,
      convoAgentId: convo.agentId,
      hasPrimarySession: !!convo.sessionId,
      knownSessionIds: convo.sessionIds.map(s => s.sessionId),
    };
  }
  if (msg.type === 'system' && msg.subtype === 'info') {
    return { hasPrimarySession: !!convo.sessionId };
  }
  if (msg.type === 'system' && msg.subtype === 'agent_switch') {
    return {
      isActive,
      convoAgentId: convo.agentId,
      toAgentExists: msg.toAgent in AGENT_TYPES,
      toAgentType: AGENT_TYPES[msg.toAgent] || null,
      fromAgentExists: msg.fromAgent in AGENT_TYPES,
    };
  }
  if (msg.type === 'result') {
    // Mirror the glue: the marker/WS half runs before reduce and decides
    // delegationTriggered from the same text the reducer will finalise.
    const textToScan = state.streamingRawText || msg.result || state.latestText || '';
    return {
      isActive,
      viewingChat: isActive && viewingChat,
      convoExists: true,
      convoInWorkspace: true,
      delegationTriggered: !!scanMarkers(textToScan).delegation,
    };
  }
  return { isActive };
}

function replay(messages, opts = {}) {
  let state = createState();
  const effects = [];
  const log = [];
  const convo = { agentId: opts.convoAgentId || 'cos', sessionId: null, sessionIds: [] };
  const flags = { isActive: opts.isActive !== false, viewingChat: opts.viewingChat !== false };
  messages.forEach((msg, i) => {
    const r = reduce(state, msg, buildCtx(msg, state, convo, flags));
    state = r.state;
    for (const ef of r.effects) {
      effects.push(ef);
      log.push(`${i}:${ef.type}`);
      if (ef.type === 'set-session') {
        if (ef.setPrimary) convo.sessionId = ef.sessionId;
        if (ef.addToChain) convo.sessionIds.push({ sessionId: ef.sessionId, agentId: ef.agentId });
      }
      if (ef.type === 'clear-session') convo.sessionId = null;
    }
  });
  return { state, effects, log, convo };
}

function types(effects) { return effects.map(e => e.type); }

// ── sequence replays (table-driven) ─────────────────────────────────────────

const SEQUENCE_TABLE = [
  {
    name: 'plain streamed turn',
    messages: seq.plainStreamedTurn,
    expectedLog: [
      '0:remove-permission-cards',
      '1:set-session',
      '3:start-streaming-bubble', '3:render-stream-text',
      '4:render-stream-text',
      '7:finalize-agent-message', '7:remove-thinking-indicator', '7:finalize-stream-bubble',
      '7:finish-processing', '7:render-convo-list',
      '8:finish-processing',
    ],
    finalState: {
      activeProcessId: 'p1', isProcessing: false, hasStreamingBubble: false,
      streamingRawText: '', latestText: '', latestAgentId: null, silentTurn: false,
    },
  },
  {
    name: 'delegation round trip (out -> delegate result -> back)',
    messages: seq.delegationRoundTrip,
    expectedLog: [
      '0:remove-permission-cards',
      '1:set-session',
      '3:start-streaming-bubble', '3:render-stream-text',
      '4:render-stream-text',
      // Orchestrator result carries DELEGATE: no finish-processing.
      '7:finalize-agent-message', '7:remove-thinking-indicator', '7:finalize-stream-bubble', '7:render-convo-list',
      // Switch out to the specialist.
      '8:clear-outgoing-working', '8:clear-streaming-bubble', '8:render-convo-list',
      '8:show-delegation-divider', '8:update-chat-header', '8:start-processing',
      '9:remove-permission-cards',
      '10:set-session',
      '12:start-streaming-bubble', '12:render-stream-text',
      '13:render-stream-text',
      // Specialist result carries RETURN only: normal finalisation.
      '16:finalize-agent-message', '16:remove-thinking-indicator', '16:finalize-stream-bubble',
      '16:finish-processing', '16:render-convo-list',
      // Switch back to the orchestrator: a return, so no start-processing here.
      '17:clear-outgoing-working', '17:clear-streaming-bubble', '17:render-convo-list',
      '17:show-delegation-divider', '17:update-chat-header',
      // Orchestrator resumes via autoContinue.
      '18:remove-permission-cards', '18:start-processing',
      '20:start-streaming-bubble', '20:render-stream-text',
      '21:render-stream-text',
      '24:finalize-agent-message', '24:remove-thinking-indicator', '24:finalize-stream-bubble',
      '24:finish-processing', '24:render-convo-list',
      '25:finish-processing',
    ],
    finalState: {
      activeProcessId: 'p3', activeAgentId: 'cos', delegationActive: false,
      isProcessing: false, hasStreamingBubble: false, streamingRawText: '',
    },
  },
  {
    name: 'stale done after a newer process started',
    messages: seq.staleDoneAfterNewerProcess,
    expectedLog: [
      '0:remove-permission-cards',
      '1:set-session',
      '2:start-streaming-bubble', '2:render-stream-text',
      '3:remove-permission-cards',
      '4:drop-stale',      // late p1 delta
      '5:drop-stale',      // late p1 done: must NOT finish processing
      '7:render-stream-text',   // bubble already exists, no new start
      '8:render-stream-text',
      '11:finalize-agent-message', '11:remove-thinking-indicator', '11:finalize-stream-bubble',
      '11:finish-processing', '11:render-convo-list',
      '12:finish-processing',
    ],
    finalState: { activeProcessId: 'p2', isProcessing: false, hasStreamingBubble: false, streamingRawText: '' },
  },
  {
    name: 'silent park',
    messages: seq.silentPark,
    expectedLog: [
      '0:remove-permission-cards', // silent turn: autoContinue must NOT start processing
      '4:suppress-silent-park', '4:finish-processing', '4:render-convo-list',
      '5:finish-processing',
    ],
    finalState: { silentTurn: false, streamingRawText: '', hasStreamingBubble: false, isProcessing: false },
  },
  {
    name: 'cancelled mid-stream',
    messages: seq.cancelledMidStream,
    expectedLog: [
      '0:remove-permission-cards',
      '1:set-session',
      '3:start-streaming-bubble', '3:render-stream-text',
      '4:add-cancelled-badge', '4:notice',
      '5:finish-processing',
    ],
    // No result ever arrived, so the raw text survives (matches app.js today:
    // only result/agent_switch clear streamingRawText).
    finalState: { streamingRawText: 'Let me work through th', hasStreamingBubble: false, isProcessing: false },
  },
];

for (const row of SEQUENCE_TABLE) {
  test(`sequence: ${row.name} produces the contracted effect stream`, () => {
    const { log } = replay(row.messages);
    assert.deepStrictEqual(log, row.expectedLog);
  });
  test(`sequence: ${row.name} lands on the contracted final state`, () => {
    const { state } = replay(row.messages);
    for (const [key, val] of Object.entries(row.finalState)) {
      assert.deepStrictEqual(state[key], val, `state.${key}`);
    }
  });
}

// ── sequence payload details ────────────────────────────────────────────────

test('plain turn: finalize carries the full text, agent and attribution', () => {
  const { effects, convo } = replay(seq.plainStreamedTurn);
  const fin = effects.find(e => e.type === 'finalize-agent-message');
  assert.strictEqual(fin.text, seq.PLAIN_TEXT);
  assert.strictEqual(fin.agentId, 'cos');
  assert.deepStrictEqual(fin.attribution, { agentId: 'cos', processId: 'p1', timestamp: null });
  assert.strictEqual(convo.sessionId, 'sess-orch');
  assert.deepStrictEqual(convo.sessionIds, [{ sessionId: 'sess-orch', agentId: 'cos' }]);
});

test('delegation round trip: session chain tracks both agents, primary stays with the orchestrator', () => {
  const { convo, effects } = replay(seq.delegationRoundTrip);
  assert.strictEqual(convo.sessionId, 'sess-orch');
  assert.deepStrictEqual(convo.sessionIds, [
    { sessionId: 'sess-orch', agentId: 'cos' },
    { sessionId: 'sess-dev', agentId: 'dev' },
  ]);
  const sessions = effects.filter(e => e.type === 'set-session');
  assert.deepStrictEqual(sessions.map(s => s.setPrimary), [true, false]);
});

test('delegation round trip: divider directions and delegate handoff text', () => {
  const { effects } = replay(seq.delegationRoundTrip);
  const dividers = effects.filter(e => e.type === 'show-delegation-divider');
  assert.deepStrictEqual(dividers.map(d => [d.toAgentId, d.isReturn]), [['dev', false], ['cos', true]]);
  const finals = effects.filter(e => e.type === 'finalize-agent-message');
  // DELEGATE strips the marker AND everything after it; RETURN strips cleanly.
  assert.deepStrictEqual(finals.map(f => f.text), [
    "I'll hand this to Dev.",
    'Widget built and tested.',
    seq.RESUME_TEXT,
  ]);
});

test('stale done: drop-stale reasons distinguish the process gate from the done gate', () => {
  const { effects } = replay(seq.staleDoneAfterNewerProcess);
  const drops = effects.filter(e => e.type === 'drop-stale');
  assert.deepStrictEqual(drops.map(d => d.reason), ['stale-process', 'stale-done']);
  assert.deepStrictEqual(drops.map(d => [d.processId, d.activeProcessId]), [['p1', 'p2'], ['p1', 'p2']]);
});

test('cancelled: badge effect carries the turn tool calls and start time', () => {
  const { effects } = replay(seq.cancelledMidStream);
  const badge = effects.find(e => e.type === 'add-cancelled-badge');
  assert.deepStrictEqual(badge.toolCalls, [{ name: 'Read' }]);
  assert.strictEqual(badge.turnStartTime, 1700000000000);
  const notice = effects.find(e => e.type === 'notice');
  assert.strictEqual(notice.content, 'Agent stopped by user.');
});

// ── createState / isStale ───────────────────────────────────────────────────

test('createState returns the initial per-conversation fields', () => {
  assert.deepStrictEqual(createState(), {
    isProcessing: false, hasStreamingBubble: false, latestText: '',
    streamingRawText: '', latestAgentId: null, activeProcessId: null,
    silentTurn: false, afterToolUse: false, activeAgentId: null, delegationActive: false,
  });
});

test('isStale: the activeProcessId acceptance rule', () => {
  const s = createState();
  assert.strictEqual(isStale(s, { type: 'result' }), false, 'no _processId is never stale');
  assert.strictEqual(isStale(s, { type: 'result', _processId: 'p1' }), false, 'no active process accepts anything');
  s.activeProcessId = 'p1';
  assert.strictEqual(isStale(s, { type: 'result', _processId: 'p1' }), false, 'matching process accepted');
  assert.strictEqual(isStale(s, { type: 'result', _processId: 'p0' }), true, 'mismatched process is stale');
});

test('reduce: unknown message types and system subtypes are no-ops', () => {
  const s = createState();
  assert.deepStrictEqual(reduce(s, { type: 'file_tree' }, {}), { state: s, effects: [] });
  assert.deepStrictEqual(reduce(s, { type: 'system', subtype: 'auth_error' }, {}), { state: s, effects: [] });
});

test('reduce: stale stream/assistant/result messages emit drop-stale and leave state untouched', () => {
  const s = { ...createState(), activeProcessId: 'p2', streamingRawText: 'kept' };
  for (const type of ['stream_event', 'assistant', 'result']) {
    const r = reduce(s, { type, _processId: 'p1' }, { isActive: true });
    assert.strictEqual(r.state.streamingRawText, 'kept');
    assert.deepStrictEqual(types(r.effects), ['drop-stale']);
    assert.strictEqual(r.effects[0].reason, 'stale-process');
    assert.strictEqual(r.effects[0].messageType, type);
  }
});

// ── process lifecycle ───────────────────────────────────────────────────────

test('process_started without a process id is a no-op', () => {
  const s = createState();
  const r = reduce(s, { type: 'system', subtype: 'process_started' }, {});
  assert.deepStrictEqual(r.effects, []);
  assert.strictEqual(r.state.activeProcessId, null);
});

test('process_started with autoContinue starts processing and clears the assistant fallback', () => {
  const s = { ...createState(), latestText: 'old', latestAgentId: 'dev' };
  const r = reduce(s, seq.processStarted('cos', 'p9', { autoContinue: true }), {});
  assert.deepStrictEqual(types(r.effects), ['remove-permission-cards', 'start-processing']);
  assert.deepStrictEqual(r.effects[1].attribution, { agentId: 'cos', processId: 'p9', timestamp: null });
  assert.strictEqual(r.state.isProcessing, true);
  assert.strictEqual(r.state.latestText, '');
  assert.strictEqual(r.state.latestAgentId, null);
});

test('done with no tracked active process still finishes', () => {
  const r = reduce(createState(), seq.done('cos', 'p1'), {});
  assert.deepStrictEqual(types(r.effects), ['finish-processing']);
  assert.strictEqual(r.state.isProcessing, false);
});

// ── session capture ─────────────────────────────────────────────────────────

test('init: missing session id or missing conversation is a no-op', () => {
  const s = createState();
  assert.deepStrictEqual(reduce(s, { type: 'system', subtype: 'init' }, { convoExists: true }).effects, []);
  assert.deepStrictEqual(reduce(s, seq.initMsg('x', 'cos', 'p1'), { convoExists: false }).effects, []);
});

test('init: a delegate session never replaces an existing primary, and duplicates never rejoin the chain', () => {
  const ctx = { convoExists: true, convoAgentId: 'cos', hasPrimarySession: true, knownSessionIds: ['sess-dev'] };
  const r = reduce(createState(), seq.initMsg('sess-dev', 'dev', 'p2'), ctx);
  assert.deepStrictEqual(r.effects, [{
    type: 'set-session', sessionId: 'sess-dev', agentId: 'dev', setPrimary: false, addToChain: false,
  }]);
});

test('init: a delegate session becomes primary when no primary exists yet', () => {
  const ctx = { convoExists: true, convoAgentId: 'cos', hasPrimarySession: false, knownSessionIds: [] };
  const r = reduce(createState(), seq.initMsg('sess-dev', 'dev', 'p2'), ctx);
  assert.strictEqual(r.effects[0].setPrimary, true);
  assert.strictEqual(r.effects[0].addToChain, true);
});

test('info clears the stored session only when one exists; notice never does', () => {
  const s = createState();
  const withSession = reduce(s, { type: 'system', subtype: 'info', content: 'Session expired' }, { hasPrimarySession: true });
  assert.deepStrictEqual(types(withSession.effects), ['clear-session', 'notice']);
  const withoutSession = reduce(s, { type: 'system', subtype: 'info', content: 'Session expired' }, { hasPrimarySession: false });
  assert.deepStrictEqual(types(withoutSession.effects), ['notice']);
  const notice = reduce(s, { type: 'system', subtype: 'notice', content: 'Write request approved' }, {});
  assert.deepStrictEqual(notice.effects, [{ type: 'notice', content: 'Write request approved' }]);
  assert.deepStrictEqual(reduce(s, { type: 'system', subtype: 'notice' }, {}).effects, [], 'notice without content is a no-op');
});

// ── streaming ───────────────────────────────────────────────────────────────

test('stream_event without an event payload is a no-op', () => {
  assert.deepStrictEqual(reduce(createState(), { type: 'stream_event' }, { isActive: true }).effects, []);
});

test('deltas accumulate raw text without render effects when the conversation is inactive', () => {
  const r = reduce(createState(), seq.relay({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hi' } } }, 'cos', 'p1'), { isActive: false });
  assert.strictEqual(r.state.streamingRawText, 'hi');
  assert.deepStrictEqual(r.effects, []);
  assert.strictEqual(r.state.hasStreamingBubble, false);
});

test('a tool use inserts a paragraph break before the next delta (only once, only after text)', () => {
  let state = createState();
  const ctx = { isActive: false };
  state = reduce(state, { type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'tool_use', name: 'Read' } } }, ctx).state;
  // No prior text: no break inserted.
  state = reduce(state, { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Reading.' } } }, ctx).state;
  assert.strictEqual(state.streamingRawText, 'Reading.');
  state = reduce(state, { type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'tool_use', name: 'Read' } } }, ctx).state;
  state = reduce(state, { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Done.' } } }, ctx).state;
  assert.strictEqual(state.streamingRawText, 'Reading.\n\nDone.');
  state = reduce(state, { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: ' More.' } } }, ctx).state;
  assert.strictEqual(state.streamingRawText, 'Reading.\n\nDone. More.', 'break applies to the first delta only');
});

test('tool use: status effect when active, file refresh only for file-writing tools', () => {
  const start = (name) => ({ type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'tool_use', name } } });
  const active = reduce(createState(), start('Write'), { isActive: true });
  assert.deepStrictEqual(types(active.effects), ['ensure-tool-status', 'schedule-file-refresh']);
  const readOnly = reduce(createState(), start('Grep'), { isActive: true });
  assert.deepStrictEqual(types(readOnly.effects), ['ensure-tool-status']);
  const inactive = reduce(createState(), start('Edit'), { isActive: false });
  assert.deepStrictEqual(types(inactive.effects), ['schedule-file-refresh'], 'refresh fires regardless of focus');
});

test('silent turns suppress the tool status but still track afterToolUse', () => {
  const s = { ...createState(), silentTurn: true };
  const r = reduce(s, { type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'tool_use', name: 'Grep' } } }, { isActive: true });
  assert.deepStrictEqual(r.effects, []);
  assert.strictEqual(r.state.afterToolUse, true);
});

test('render-stream-text strips complete, standalone and partially streamed RUNDOCK markers', () => {
  const raw = 'Before <!-- RUNDOCK:SAVE_AGENT name=x -->\nsecret\n<!-- /RUNDOCK:SAVE_AGENT --> mid <!-- RUNDOCK:RETURN --> after <!-- RUNDOCK:DELEG';
  const r = reduce(createState(), { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: raw } } }, { isActive: true });
  const render = r.effects.find(e => e.type === 'render-stream-text');
  assert.strictEqual(render.text, 'Before  mid  after ');
  assert.strictEqual(r.state.streamingRawText, raw, 'raw text keeps the markers for the result scan');
});

test('the streaming bubble starts once, attributed to the message agent then the delegation fallback', () => {
  const delta = { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'x' } } };
  let r = reduce({ ...createState(), activeAgentId: 'dev' }, delta, { isActive: true });
  assert.strictEqual(r.effects[0].type, 'start-streaming-bubble');
  assert.strictEqual(r.effects[0].agentId, 'dev');
  r = reduce(r.state, delta, { isActive: true });
  assert.deepStrictEqual(types(r.effects), ['render-stream-text'], 'no second bubble');
});

// ── assistant fallback ──────────────────────────────────────────────────────

test('assistant records latestText; tool_use blocks update the status only when active', () => {
  const msg = { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Answer.' }, { type: 'tool_use', name: 'Read' }] }, _agent: 'cos' };
  const active = reduce(createState(), msg, { isActive: true });
  assert.strictEqual(active.state.latestText, 'Answer.');
  assert.strictEqual(active.state.latestAgentId, 'cos');
  assert.deepStrictEqual(types(active.effects), ['update-tool-status']);
  const inactive = reduce(createState(), msg, { isActive: false });
  assert.deepStrictEqual(inactive.effects, []);
  assert.deepStrictEqual(reduce(createState(), { type: 'assistant' }, {}).effects, [], 'no content is a no-op');
});

test('result falls back to the assistant text only when no deltas were seen', () => {
  const ctx = { isActive: true, viewingChat: true, convoExists: true, convoInWorkspace: true, delegationTriggered: false };
  // No deltas, empty result field: assistant fallback wins.
  const fromAssistant = reduce({ ...createState(), latestText: 'Fallback answer.', latestAgentId: 'cos' }, { type: 'result', result: '' }, ctx);
  assert.strictEqual(fromAssistant.effects.find(e => e.type === 'finalize-agent-message').text, 'Fallback answer.');
  // Deltas seen: streamed text wins over both result and assistant text.
  const fromStream = reduce({ ...createState(), streamingRawText: 'Streamed.', latestText: 'Fallback.' }, { type: 'result', result: 'ResultField.' }, ctx);
  assert.strictEqual(fromStream.effects.find(e => e.type === 'finalize-agent-message').text, 'Streamed.');
});

// ── result finalisation ─────────────────────────────────────────────────────

const RESULT_CTX = { isActive: true, viewingChat: true, convoExists: true, convoInWorkspace: true, delegationTriggered: false };

test('a short answer without streaming renders as a fresh message, not a bubble re-render', () => {
  const r = reduce({ ...createState(), latestText: 'Forty.' }, { type: 'result', result: '', _agent: 'cos' }, RESULT_CTX);
  assert.deepStrictEqual(types(r.effects), [
    'finalize-agent-message', 'remove-thinking-indicator', 'append-final-message', 'finish-processing', 'render-convo-list',
  ]);
  assert.strictEqual(r.effects[2].text, 'Forty.', 'short answers on normal turns must never be swallowed');
});

test('an empty result on an inactive conversation only finishes and re-renders the list', () => {
  const r = reduce(createState(), { type: 'result', result: '' }, { ...RESULT_CTX, isActive: false });
  assert.deepStrictEqual(types(r.effects), ['finish-processing', 'render-convo-list']);
});

test('a finalised message marks the conversation unread when not being viewed', () => {
  const r = reduce({ ...createState(), streamingRawText: 'Hello there world.' }, { type: 'result' }, { ...RESULT_CTX, isActive: false, viewingChat: false });
  assert.deepStrictEqual(types(r.effects), ['finalize-agent-message', 'mark-unread', 'finish-processing', 'render-convo-list']);
});

test('silent-park no-op heuristic: park context plus sentinel/short/stock text suppresses the turn', () => {
  const park = (state, text) => reduce({ ...createState(), ...state }, { type: 'result', result: text }, RESULT_CTX);
  // Sentinel makes its own park context.
  assert.deepStrictEqual(types(park({}, '<silent>').effects), ['suppress-silent-park', 'finish-processing', 'render-convo-list']);
  // Server-flagged silent turn with a stock acknowledgement.
  assert.deepStrictEqual(types(park({ silentTurn: true }, 'Understood.').effects), ['suppress-silent-park', 'finish-processing', 'render-convo-list']);
  // Park context but a real answer: renders normally.
  const real = park({ silentTurn: true }, 'Here is a full considered answer to the question.');
  assert.ok(types(real.effects).includes('finalize-agent-message'));
  // Normal turn, short answer: the heuristic must NOT apply.
  const short = park({}, 'Ten.');
  assert.ok(types(short.effects).includes('finalize-agent-message'));
  // Empty text is never treated as a park (matches the old `isNoOp && responseText` guard).
  assert.deepStrictEqual(types(park({ silentTurn: true }, '').effects), ['remove-thinking-indicator', 'finish-processing', 'render-convo-list']);
});

test('silent park during a delegation does not finish processing', () => {
  const r = reduce({ ...createState(), silentTurn: true }, { type: 'result', result: '<silent>' }, { ...RESULT_CTX, delegationTriggered: true });
  assert.deepStrictEqual(types(r.effects), ['suppress-silent-park', 'render-convo-list']);
  assert.strictEqual(r.state.isProcessing, false, 'processing flag untouched (was false)');
});

test('result resets the streaming fields and the silent flag', () => {
  const s = { ...createState(), streamingRawText: 'Text here for you.', latestText: 'x', latestAgentId: 'cos', silentTurn: false, hasStreamingBubble: true };
  const r = reduce(s, { type: 'result' }, RESULT_CTX);
  assert.strictEqual(r.state.streamingRawText, '');
  assert.strictEqual(r.state.latestText, '');
  assert.strictEqual(r.state.latestAgentId, null);
  assert.strictEqual(r.state.hasStreamingBubble, false);
  assert.strictEqual(r.state.silentTurn, false);
});

// ── agent_switch / delegation ───────────────────────────────────────────────

const SWITCH_CTX = { isActive: true, convoAgentId: 'cos', toAgentExists: true, toAgentType: 'specialist', fromAgentExists: true };

test('agent_switch promotes in-progress streamed text with markers stripped', () => {
  const s = { ...createState(), streamingRawText: 'Handing off now.\n<!-- RUNDOCK:DELEGATE agent=dev -->\nbrief\n<!-- /RUNDOCK:DELEGATE -->', hasStreamingBubble: true };
  const r = reduce(s, seq.agentSwitch('cos', 'dev', 'p2'), SWITCH_CTX);
  const promote = r.effects.find(e => e.type === 'promote-handoff-message');
  assert.strictEqual(promote.text, 'Handing off now.');
  assert.strictEqual(promote.agentId, 'cos', 'attributed to the outgoing agent');
  assert.deepStrictEqual(promote.attribution, { agentId: null, processId: 'p2', timestamp: null });
  assert.strictEqual(r.state.hasStreamingBubble, false);
  assert.strictEqual(r.state.streamingRawText, '');
});

test('agent_switch with marker-only streamed text promotes nothing', () => {
  const s = { ...createState(), streamingRawText: '<!-- RUNDOCK:DELEGATE agent=dev -->\nbrief\n<!-- /RUNDOCK:DELEGATE -->' };
  const r = reduce(s, seq.agentSwitch('cos', 'dev', 'p2'), SWITCH_CTX);
  assert.strictEqual(r.effects.find(e => e.type === 'promote-handoff-message'), undefined);
});

test('agent_switch to an unknown agent: no divider, no header, no processing start', () => {
  const ctx = { ...SWITCH_CTX, toAgentExists: false, toAgentType: null, fromAgentExists: true };
  const r = reduce(createState(), seq.agentSwitch('cos', 'ghost', 'p2'), ctx);
  assert.deepStrictEqual(types(r.effects), ['clear-outgoing-working', 'clear-streaming-bubble', 'render-convo-list']);
  assert.strictEqual(r.state.delegationActive, false);
  assert.strictEqual(r.state.activeAgentId, 'ghost');
});

test('agent_switch on an inactive conversation updates state but skips the view effects', () => {
  const r = reduce(createState(), seq.agentSwitch('cos', 'dev', 'p2'), { ...SWITCH_CTX, isActive: false });
  assert.deepStrictEqual(types(r.effects), ['clear-outgoing-working', 'clear-streaming-bubble', 'render-convo-list', 'start-processing']);
  assert.strictEqual(r.state.delegationActive, true);
  assert.strictEqual(r.state.isProcessing, true);
});

test('agent_switch with no outgoing agent identity skips the working-indicator clear', () => {
  const r = reduce(createState(), seq.agentSwitch(null, 'dev', 'p2'), { ...SWITCH_CTX, convoAgentId: undefined, fromAgentExists: false });
  assert.strictEqual(r.effects.find(e => e.type === 'clear-outgoing-working'), undefined);
});

test('attribution fields default to null when the message omits them', () => {
  const r = reduce(createState(), { type: 'system', subtype: 'done' }, {});
  assert.deepStrictEqual(r.effects[0].attribution, { agentId: null, processId: null, timestamp: null });
});
