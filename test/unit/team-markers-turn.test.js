'use strict';
// Which turn's markers are acted on, and as whose, measured on the real
// wireProcessHandlers over a fake process's stdout (the harness pattern of
// engine-live-delivery.test.js).
//
// The decision reads two things the server owns: the text it collected from
// the process whose turn ended, and the agent id recorded on that process's
// entry. These tests feed the stream and record which handler the decision
// reached, with the handlers and the broadcast swapped in-process.
const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const engineLib = require(path.join(ROOT, 'lib', 'delegation', 'engine.js'));
const teamMarkers = require(path.join(ROOT, 'lib', 'agents', 'team-markers.js'));
const team = require(path.join(ROOT, 'lib', 'protocol', 'handlers', 'team.js'));

const wire = {
  textDelta: (text) => ({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } }),
  messageStop: () => ({ type: 'stream_event', event: { type: 'message_stop' } }),
  result: (text) => ({ type: 'result', subtype: 'success', result: text, session_id: 's1' }),
};
const MARKER = '<!-- RUNDOCK:DELETE_AGENT name=example-agent -->';

function fakeProcess() {
  const p = new EventEmitter();
  p.stdout = new EventEmitter();
  p.stderr = new EventEmitter();
  p.stdin = { writable: true, write() {}, end() {} };
  p.pid = 4242;
  p.kill = () => {};
  return p;
}

// The deletes the decision reached, and the lines it broadcast.
let deletes;
let lines;
let realDelete;
beforeEach(() => {
  deletes = [];
  lines = [];
  realDelete = team.handleDeleteAgent;
  team.handleDeleteAgent = (ctx, ws, msg) => {
    deletes.push(msg.agentId);
    ws.send(JSON.stringify({ type: 'agent_deleted', agentId: msg.agentId, conversationId: msg.conversationId }));
  };
  teamMarkers.wireTeamMarkers({ broadcast: (payload) => lines.push(JSON.parse(payload)) });
});
afterEach(() => {
  team.handleDeleteAgent = realDelete;
  teamMarkers.wireTeamMarkers(null);
});

// One conversation, 'c1', whose CURRENT process may be a different entry from
// the one whose turn is fed.
function turnOf(agentId, { current } = {}) {
  const deps = {};
  for (const name of engineLib.DEP_NAMES) deps[name] = () => {};
  deps.processes = new Map();
  deps.MAX_CONSECUTIVE_AGENT_RESUMES = 3;
  deps.RESTORE_DELAY_MS = 0;
  deps.safeSend = () => {};
  deps.appendTranscript = () => {};
  deps.isSilentParkResponse = () => false;
  deps.discoverAgents = () => [];
  const engine = engineLib.createDelegationEngine(deps);
  const proc = fakeProcess();
  const entry = {
    process: proc, agentId, processId: 'p1', runtime: 'claude',
    buffer: '', responseText: '', toolCalls: [], exited: false, pendingAgentTools: [], deliveredTurns: [],
  };
  deps.processes.set('c1', current ? { ...entry, agentId: current, processId: 'p2' } : entry);
  // The decision is handed the same process table the server's handler
  // context carries, so reading the conversation's current process from it
  // would be possible, and these tests would see it.
  teamMarkers.wireTeamMarkers({ broadcast: (payload) => lines.push(JSON.parse(payload)), processes: deps.processes });
  engine.wireProcessHandlers(entry, 'c1', null, {});
  const emit = (...objs) => { for (const o of objs) proc.stdout.emit('data', Buffer.from(JSON.stringify(o) + '\n')); };
  return { entry, emit };
}

describe('the turn that ended, as the agent its entry records', () => {
  test('Doc\'s turn deletes, once, and the line carries the conversation', () => {
    const t = turnOf('rundock-guide');
    t.emit(wire.textDelta(`Removing it.\n${MARKER}`), wire.messageStop(), wire.result(`Removing it.\n${MARKER}`));
    assert.deepStrictEqual(deletes, ['example-agent']);
    assert.deepStrictEqual(lines.map((m) => [m.type, m.conversationId]), [['agent_deleted', 'c1']]);
  });

  test('Doc\'s turn is Doc\'s even when the conversation\'s current process is another agent', () => {
    const t = turnOf('rundock-guide', { current: 'content-lead' });
    t.emit(wire.textDelta(MARKER), wire.messageStop(), wire.result(MARKER));
    assert.deepStrictEqual(deletes, ['example-agent'], 'the author is the entry whose turn ended');
  });

  test('another agent\'s turn is refused even when the conversation\'s current process is Doc', () => {
    const t = turnOf('content-lead', { current: 'rundock-guide' });
    t.emit(wire.textDelta(MARKER), wire.messageStop(), wire.result(MARKER));
    assert.deepStrictEqual(deletes, [], 'nothing reached the delete');
    assert.strictEqual(lines.length, 1);
    assert.strictEqual(lines[0].refused, true);
    assert.match(lines[0].message, /asked to delete the agent "example-agent", but only Doc can change the team/);
  });

  test('the text read is what the process streamed, not the result envelope\'s copy', () => {
    // The envelope's own copy can lose HTML comments. Here it has: the
    // marker streamed, and the result carries only the words around it.
    const t = turnOf('rundock-guide');
    t.emit(wire.textDelta(`Removing it.\n${MARKER}`), wire.messageStop(), wire.result('Removing it.'));
    assert.deepStrictEqual(deletes, ['example-agent']);
  });

  test('a turn whose entry has exited is not acted on, even if its result still arrives', () => {
    const t = turnOf('rundock-guide');
    t.emit(wire.textDelta(MARKER));
    // The engine's half of a cancel: the flags the cancel handler sets on the
    // entry (process-control.js), set here by hand, before a result already in
    // the pipe is read. The cancel itself, sent through the real server and
    // followed by the runtime finishing its turn, is tested in
    // test/integration/team-markers-edges.test.js.
    t.entry.cancelled = true;
    t.entry.exited = true;
    t.emit(wire.messageStop(), wire.result(MARKER));
    assert.deepStrictEqual(deletes, [], 'nothing reached the delete');
    assert.deepStrictEqual(lines, [], 'and nothing was said about it');
  });

  test('a marker is acted on once per turn: the next turn starts from its own text', () => {
    const t = turnOf('rundock-guide');
    t.emit(wire.textDelta(MARKER), wire.messageStop(), wire.result(MARKER));
    t.entry.responseText = ''; // the reset each runtime path makes after a turn (onResult)
    t.emit(wire.textDelta('Anything else?'), wire.messageStop(), wire.result('Anything else?'));
    assert.deepStrictEqual(deletes, ['example-agent']);
  });
});

describe('the words a person reads', () => {
  // User-facing copy, pinned whole: who asked, for what, why nothing changed,
  // and what to do instead. UK spelling, as for everything a person reads.
  test('the refusal of another agent\'s marker, for a save and for a delete', () => {
    assert.strictEqual(teamMarkers.refusalLine('Wren', { kind: 'save_agent', name: 'helper' }),
      'Wren asked to save the agent "helper", but only Doc can change the team, so nothing was saved. Ask Doc to make this change.');
    assert.strictEqual(teamMarkers.refusalLine('Wren', { kind: 'delete_skill', name: 'notes' }),
      'Wren asked to delete the skill "notes", but only Doc can change the team, so nothing was deleted. Ask Doc to make this change.');
  });

  test('the refusal of Doc\'s marker for its own file or a platform agent', () => {
    const t = turnOf('rundock-guide');
    t.emit(wire.textDelta('<!-- RUNDOCK:DELETE_AGENT name=rundock-guide -->'), wire.messageStop(), wire.result(''));
    assert.deepStrictEqual(deletes, []);
    assert.deepStrictEqual(lines.map((m) => [m.type, m.refused, m.message]), [['agent_error', true,
      'Doc asked to delete the agent "rundock-guide", but Doc\'s own file and platform agents cannot be changed from a reply, so nothing was deleted.']]);
  });

  test('the refusal of a socket message', () => {
    const sent = [];
    team.handleTeamChangeRefused({}, { send: (m) => sent.push(JSON.parse(m)) }, { type: 'save_agent', name: 'helper', conversationId: 'c1' });
    assert.deepStrictEqual(sent, [{ type: 'agent_error', refused: true, conversationId: 'c1',
      message: 'Only Doc can change the team, from its own replies, so this request was refused and nothing was changed.' }]);
  });
});
