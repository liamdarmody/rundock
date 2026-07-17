'use strict';
// SHARED orchestration sequence fixtures: the client-side WebSocket message
// streams the server sends for whole conversational turns, as consumed by
// RundockConversationState.reduce (public/conversation-state.js).
//
// Envelope shapes are derived from server.js's actual safeSend call sites:
//   - stream-json lines are relayed with _agent/_conversationId/_processId
//     stamped on (wireProcessHandlers), and init lines additionally get
//     _sessionId copied from session_id.
//   - result lines additionally get _toolCalls and _turnStartTime.
//   - process_started / done / agent_switch / cancelled are synthesised by
//     the server with the exact field sets reproduced below.
// The stream-json payloads themselves come from test/fixtures/stream-json.js
// so there is one source of truth for the wire format.

const sj = require('./stream-json.js');

const CONVO_ID = 'convo-1';
const ORCHESTRATOR = 'cos';
const SPECIALIST = 'dev';

// Stamp the relay fields the server adds to every parsed stream-json line.
function relay(msg, agent, processId) {
  return { ...msg, _agent: agent, _conversationId: CONVO_ID, _processId: processId };
}

function initMsg(sessionId, agent, processId) {
  // Server copies session_id to _sessionId before relaying the init line.
  return { ...relay(sj.init(sessionId), agent, processId), _sessionId: sessionId };
}

function resultMsg(text, agent, processId, { toolCalls = [], turnStartTime = null } = {}) {
  return { ...relay(sj.result({ text }), agent, processId), _toolCalls: toolCalls, _turnStartTime: turnStartTime };
}

function processStarted(agent, processId, extra = {}) {
  return { type: 'system', subtype: 'process_started', _conversationId: CONVO_ID, _processId: processId, _agent: agent, ...extra };
}

function done(agent, processId, code = 0) {
  return { type: 'system', subtype: 'done', code, _agent: agent, _conversationId: CONVO_ID, _processId: processId };
}

function agentSwitch(fromAgent, toAgent, processId) {
  return { type: 'system', subtype: 'agent_switch', _conversationId: CONVO_ID, _processId: processId, fromAgent, toAgent };
}

function cancelled(agent, processId, { toolCalls = [], turnStartTime = null } = {}) {
  return {
    type: 'system', subtype: 'cancelled',
    _conversationId: CONVO_ID, _processId: processId, _agent: agent,
    _toolCalls: toolCalls, _turnStartTime: turnStartTime,
  };
}

// A streamed text turn as the client sees it: block start, deltas, block
// stop, assistant echo, then the result completion signal.
function streamedTurn(text, agent, processId, chunks = 2) {
  return sj.textTurn(text, { deltaChunks: chunks })
    .map(m => (m.type === 'result' ? resultMsg(text, agent, processId) : relay(m, agent, processId)));
}

// ── Named sequences ─────────────────────────────────────────────────────────

// A plain streamed turn: one agent, streamed deltas, result, done.
const PLAIN_TEXT = 'Here is the plan: start small and iterate.';
const plainStreamedTurn = [
  processStarted(ORCHESTRATOR, 'p1'),
  initMsg('sess-orch', ORCHESTRATOR, 'p1'),
  ...streamedTurn(PLAIN_TEXT, ORCHESTRATOR, 'p1'),
  done(ORCHESTRATOR, 'p1'),
];

// Delegation round trip: the orchestrator streams a handoff with a DELEGATE
// marker, the specialist runs and signals RETURN, the orchestrator resumes
// via autoContinue and closes the turn.
const DELEGATE_TEXT = 'I\'ll hand this to Dev.\n<!-- RUNDOCK:DELEGATE agent=dev -->\nBuild the widget.\n<!-- /RUNDOCK:DELEGATE -->';
const SPECIALIST_TEXT = 'Widget built and tested.\n<!-- RUNDOCK:RETURN -->';
const RESUME_TEXT = 'Dev finished the widget: all done.';
const delegationRoundTrip = [
  processStarted(ORCHESTRATOR, 'p1'),
  initMsg('sess-orch', ORCHESTRATOR, 'p1'),
  ...streamedTurn(DELEGATE_TEXT, ORCHESTRATOR, 'p1'),
  agentSwitch(ORCHESTRATOR, SPECIALIST, 'p2'),
  processStarted(SPECIALIST, 'p2'),
  initMsg('sess-dev', SPECIALIST, 'p2'),
  ...streamedTurn(SPECIALIST_TEXT, SPECIALIST, 'p2'),
  agentSwitch(SPECIALIST, ORCHESTRATOR, 'p3'),
  processStarted(ORCHESTRATOR, 'p3', { autoContinue: true }),
  ...streamedTurn(RESUME_TEXT, ORCHESTRATOR, 'p3'),
  done(ORCHESTRATOR, 'p3'),
];

// Stale done after a newer process started: p1's late done (and a late p1
// delta) must be dropped; p2 proceeds normally.
const staleDoneAfterNewerProcess = [
  processStarted(ORCHESTRATOR, 'p1'),
  initMsg('sess-orch', ORCHESTRATOR, 'p1'),
  relay(sj.textDelta('First answer in progr'), ORCHESTRATOR, 'p1'),
  processStarted(ORCHESTRATOR, 'p2'),
  relay(sj.textDelta('esss...'), ORCHESTRATOR, 'p1'), // stale delta from p1
  done(ORCHESTRATOR, 'p1'),                           // stale done from p1
  ...streamedTurn('Fresh answer.', ORCHESTRATOR, 'p2'),
  done(ORCHESTRATOR, 'p2'),
];

// Silent park: the server restarts the orchestrator silently after a
// completed pipeline; the agent replies with the <silent> sentinel and the
// whole turn is suppressed instead of rendered.
const silentPark = [
  processStarted(ORCHESTRATOR, 'p1', { autoContinue: true, silent: true }),
  relay(sj.contentBlockStartText(), ORCHESTRATOR, 'p1'),
  relay(sj.textDelta('<silent>'), ORCHESTRATOR, 'p1'),
  relay(sj.contentBlockStop(), ORCHESTRATOR, 'p1'),
  resultMsg('<silent>', ORCHESTRATOR, 'p1'),
  done(ORCHESTRATOR, 'p1'),
];

// Cancelled mid-stream: the user stops the agent while text is streaming;
// the server sends cancelled (with the turn's tool calls) before done.
const cancelledMidStream = [
  processStarted(ORCHESTRATOR, 'p1'),
  initMsg('sess-orch', ORCHESTRATOR, 'p1'),
  relay(sj.contentBlockStartText(), ORCHESTRATOR, 'p1'),
  relay(sj.textDelta('Let me work through th'), ORCHESTRATOR, 'p1'),
  cancelled(ORCHESTRATOR, 'p1', { toolCalls: [{ name: 'Read' }], turnStartTime: 1700000000000 }),
  done(ORCHESTRATOR, 'p1'),
];

module.exports = {
  CONVO_ID, ORCHESTRATOR, SPECIALIST,
  PLAIN_TEXT, DELEGATE_TEXT, SPECIALIST_TEXT, RESUME_TEXT,
  relay, initMsg, resultMsg, processStarted, done, agentSwitch, cancelled, streamedTurn,
  plainStreamedTurn, delegationRoundTrip, staleDoneAfterNewerProcess, silentPark, cancelledMidStream,
};
