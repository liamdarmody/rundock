'use strict';
// A CLAUDE CODE TURN THAT GOES QUIET IS STILL SHOWN AS WORKING.
//
// The chat screen finishes any turn it has heard nothing from for 90 seconds.
// Claude Code prints nothing while it summarizes a long conversation, while it
// thinks before its first words, while a tool runs without output and while a
// permission card waits, so the server sends a keepalive for the turn every 25
// seconds until it ends. These drive the real wireProcessHandlers over a fake
// process, with node:test mock timers standing in for the clock, and read what
// reached the socket.
const { test, describe } = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const ENGINE = path.join(ROOT, 'lib', 'delegation', 'engine.js');
const engineLib = require(ENGINE);
const processControl = require(path.join(ROOT, 'lib', 'protocol', 'handlers', 'process-control.js'));
const { createState, reduce } = require(path.join(ROOT, 'public', 'conversation-state.js'));

const INTERVAL = 25000;
const ENV = 'RUNDOCK_CLAUDE_KEEPALIVE_MS';

// No pid, so a Stop that reaches the process-tree kill signals nothing real.
function fakeProcess() {
  const p = new EventEmitter();
  p.stdout = new EventEmitter();
  p.stderr = new EventEmitter();
  p.stdin = { writable: true, write() {}, end() {} };
  p.killed = false;
  p.pid = undefined;
  p.kill = () => { p.killed = true; };
  return p;
}

const wire = {
  compacting: () => ({ type: 'system', subtype: 'status', status: 'compacting' }),
  compacted: () => ({ type: 'system', subtype: 'status', status: null, compact_result: 'success' }),
  boundary: (uuid) => ({ type: 'system', subtype: 'compact_boundary', uuid }),
  textDelta: (text) => ({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } }),
  messageStop: () => ({ type: 'stream_event', event: { type: 'message_stop' } }),
  result: (text) => ({ type: 'result', subtype: 'success', result: text, session_id: 's1' }),
};

// What every real onResult does once it has stored the turn's reply (the
// chat's in server.js and the engine's own): it parks the entry until its next
// message.
function parkOnResult(e) {
  e.responseText = '';
  e.idle = true; e.idleSince = Date.now();
}

function harness({ lib = engineLib, idle, onResult } = {}) {
  const sent = [];
  const deps = {};
  for (const name of lib.DEP_NAMES) deps[name] = () => {};
  deps.processes = new Map();
  deps.MAX_CONSECUTIVE_AGENT_RESUMES = 3;
  deps.RESTORE_DELAY_MS = 0;
  deps.safeSend = (payload) => { try { sent.push(JSON.parse(payload)); } catch (e) { sent.push({ unparsed: payload }); } };
  deps.appendTranscript = () => {};
  deps.isSilentParkResponse = () => false;
  deps.discoverAgents = () => ([{ id: 'alpha', name: 'alpha', displayName: 'Alpha', type: 'orchestrator' }]);
  const engine = lib.createDelegationEngine(deps);

  // Wires a process the way a spawn does: its first message is its first turn.
  const start = (convoId, processId, opts = {}) => {
    const proc = fakeProcess();
    const entry = {
      process: proc, agentId: 'alpha', processId, runtime: 'claude',
      buffer: '', responseText: '', toolCalls: [], exited: false,
      pendingAgentTools: [], deliveredTurns: [],
    };
    if (opts.idle !== undefined) entry.idle = opts.idle;
    deps.processes.set(convoId, entry);
    engine.wireProcessHandlers(entry, convoId, null, { onResult: opts.onResult });
    const emit = (...objs) => {
      for (const o of objs) proc.stdout.emit('data', Buffer.from(JSON.stringify(o) + '\n'));
    };
    return { entry, proc, emit };
  };

  const first = start('c1', 'p1', { idle, onResult });
  const beats = (processId) => sent.filter(m => m.type === 'system' && m.subtype === 'keepalive'
    && (!processId || m._processId === processId));
  return { sent, deps, engine, start, beats, ...first };
}

// What the person's next message does to a live process (server.js), and what
// the two automatic continues do in the engine: the entry is given a new turn.
function giveNextTurn(entry) {
  entry.resultSent = false;
  entry.idle = false;
  entry.idleSince = null;
  if (typeof entry.startTurnKeepalive === 'function') entry.startTurnKeepalive();
}

// Records every interval created and cleared while it is installed, and
// whether each was unref'd. Mock timers' own unref does nothing, so it is
// watched rather than read back.
function watchIntervals() {
  const made = [];
  const cleared = new Set();
  const realSet = globalThis.setInterval;
  const realClear = globalThis.clearInterval;
  globalThis.setInterval = function (...args) {
    const timer = realSet(...args);
    const rec = { timer, unrefd: false };
    const unref = timer.unref;
    timer.unref = function () { rec.unrefd = true; return unref ? unref.apply(this, arguments) : this; };
    made.push(rec);
    return timer;
  };
  globalThis.clearInterval = function (timer) { cleared.add(timer); return realClear(timer); };
  const restore = () => { globalThis.setInterval = realSet; globalThis.clearInterval = realClear; };
  return { made, cleared, restore };
}

describe('a quiet Claude Code turn has a heartbeat', () => {
  test('a process that prints nothing after its first message gets a keepalive in every interval', (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    const h = harness();
    for (let i = 1; i <= 4; i++) {
      t.mock.timers.tick(INTERVAL);
      assert.strictEqual(h.beats('p1').length, i, `one keepalive per interval of silence, interval ${i}`);
    }
    for (const beat of h.beats('p1')) {
      assert.strictEqual(beat._conversationId, 'c1', 'the keepalive carries its conversation');
      assert.strictEqual(beat._processId, 'p1', 'and its process, for the stale check');
      assert.strictEqual(beat._agent, 'alpha');
    }
  });

  test('a process that prints compacting and then nothing for more than three intervals gets a keepalive in each', (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    const h = harness();
    h.emit(wire.compacting());
    const before = h.beats('p1').length;
    for (let i = 1; i <= 4; i++) {
      t.mock.timers.tick(INTERVAL);
      assert.strictEqual(h.beats('p1').length - before, i, `a keepalive in interval ${i} of the summary`);
    }
  });

  test('a keepalive carries the ids the screen gates on and nothing of the turn', (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    const h = harness();
    h.emit(wire.textDelta('a private sentence from the reply'));
    t.mock.timers.tick(INTERVAL);
    const beat = h.beats('p1')[0];
    assert.ok(beat, 'a keepalive was sent');
    assert.deepStrictEqual(Object.keys(beat).sort(), ['_agent', '_conversationId', '_processId', 'subtype', 'type']);
    assert.ok(!JSON.stringify(beat).includes('private sentence'), 'no response text rides on a keepalive');
  });

  test('a process parked with no turn sends nothing until it is given one', (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    const h = harness({ idle: true });
    t.mock.timers.tick(INTERVAL * 3);
    assert.strictEqual(h.beats().length, 0, 'a parked process waiting for its next message is silent');
    giveNextTurn(h.entry);
    t.mock.timers.tick(INTERVAL);
    assert.strictEqual(h.beats('p1').length, 1, 'its turn has a heartbeat');
  });
});

describe('the heartbeat stops', () => {
  test('the result stops it', (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    const h = harness();
    t.mock.timers.tick(INTERVAL);
    assert.strictEqual(h.beats('p1').length, 1, 'beating before the result');
    h.emit(wire.result('Done.'));
    t.mock.timers.tick(INTERVAL * 4);
    assert.strictEqual(h.beats('p1').length, 1, 'no keepalive after the result');
  });

  test('close stops it', (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    const h = harness();
    t.mock.timers.tick(INTERVAL);
    assert.strictEqual(h.beats('p1').length, 1, 'beating before the close');
    h.proc.emit('close', 0);
    t.mock.timers.tick(INTERVAL * 4);
    assert.strictEqual(h.beats('p1').length, 1, 'no keepalive after the close');
  });

  test('exit stops it before the close arrives', (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    const h = harness();
    t.mock.timers.tick(INTERVAL);
    assert.strictEqual(h.beats('p1').length, 1, 'beating before the exit');
    h.proc.emit('exit', 1, null);
    t.mock.timers.tick(INTERVAL * 4);
    assert.strictEqual(h.beats('p1').length, 1, 'no keepalive after the exit');
  });

  test('Stop stops it at once, before the process has closed', (t) => {
    t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
    const w = watchIntervals();
    try {
      const h = harness();
      t.mock.timers.tick(INTERVAL);
      assert.strictEqual(h.beats('p1').length, 1, 'beating before Stop');
      const broadcasts = [];
      const ctx = { processes: h.deps.processes, pendingPermissions: new Map(), broadcast: (m) => broadcasts.push(JSON.parse(m)) };
      processControl.handleCancel(ctx, null, { type: 'cancel', conversationId: 'c1' });
      assert.ok(broadcasts.some(m => m.subtype === 'cancelled'), 'sanity: Stop ran as it does today');
      assert.ok(w.made.length >= 1, 'sanity: the heartbeat timer was seen');
      for (const rec of w.made) assert.ok(w.cleared.has(rec.timer), 'Stop clears the heartbeat itself, not its next tick');
      t.mock.timers.tick(INTERVAL * 4);
      assert.strictEqual(h.beats('p1').length, 1, 'no keepalive after Stop');
    } finally {
      w.restore();
    }
  });

  test('none between turns, and the next turn starts it again, once', (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    const h = harness();
    t.mock.timers.tick(INTERVAL);
    assert.strictEqual(h.beats('p1').length, 1, 'the first turn beats');
    h.emit(wire.result('First answer.'));
    h.entry.idle = true; h.entry.idleSince = Date.now(); // what onResult does
    t.mock.timers.tick(INTERVAL * 3);
    assert.strictEqual(h.beats('p1').length, 1, 'nothing while the process waits for its next message');
    giveNextTurn(h.entry);
    t.mock.timers.tick(INTERVAL);
    assert.strictEqual(h.beats('p1').length, 2, 'the next turn beats');
    t.mock.timers.tick(INTERVAL);
    assert.strictEqual(h.beats('p1').length, 3, 'once per interval, not twice');
  });

  test('a process never has two heartbeats at once', (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    const h = harness();
    giveNextTurn(h.entry);
    giveNextTurn(h.entry);
    t.mock.timers.tick(INTERVAL);
    assert.strictEqual(h.beats('p1').length, 1, 'starting again while it beats adds no second heartbeat');
    t.mock.timers.tick(INTERVAL);
    assert.strictEqual(h.beats('p1').length, 2);
  });

  test('a new process in the same entry has one heartbeat, and the old process closing late does not stop it', (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    const h = harness();
    t.mock.timers.tick(INTERVAL);
    assert.strictEqual(h.beats('p1').length, 1, 'beating for the first process');
    // A fresh start reuses the entry with a new process (startWithoutSession).
    const oldProc = h.proc;
    const next = fakeProcess();
    h.entry.process = next; h.entry.buffer = ''; h.entry.exited = false;
    h.engine.wireProcessHandlers(h.entry, 'c1', null, {});
    t.mock.timers.tick(INTERVAL);
    assert.strictEqual(h.beats('p1').length, 2, 'one keepalive in the interval, not one per process');
    oldProc.emit('close', 0);
    t.mock.timers.tick(INTERVAL);
    assert.strictEqual(h.beats('p1').length, 3, 'the old process closing does not stop the new one');
  });

  test('a late result from a replaced process reaches neither the screen nor its successor\'s turn, whose heartbeat runs until its own result', (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    // Both processes are wired as the real handlers wire them: a result parks
    // the entry until its next message, which silences the heartbeat.
    const h = harness({ idle: false, onResult: parkOnResult });
    t.mock.timers.tick(INTERVAL);
    assert.strictEqual(h.beats('p1').length, 1, 'beating for the first process');
    // A fresh start reuses the entry with a new process (startWithoutSession).
    const oldProc = h.proc;
    const next = fakeProcess();
    h.entry.process = next; h.entry.buffer = ''; h.entry.exited = false;
    h.engine.wireProcessHandlers(h.entry, 'c1', null, { onResult: parkOnResult });
    const emitFrom = (proc, ...objs) => {
      for (const o of objs) proc.stdout.emit('data', Buffer.from(JSON.stringify(o) + '\n'));
    };
    emitFrom(next, wire.textDelta('Still working. '));
    t.mock.timers.tick(INTERVAL);
    const quiet = h.beats('p1').length;
    assert.strictEqual(quiet, 2, 'the new process beats while it works quietly');
    const before = h.sent.length;
    emitFrom(oldProc, wire.textDelta('A late answer from the replaced process.'),
      wire.result('A late answer from the replaced process.'));
    const late = h.sent.slice(before);
    for (let i = 1; i <= 4; i++) {
      t.mock.timers.tick(INTERVAL);
      assert.strictEqual(h.beats('p1').length - quiet, i, `the new process still beats in interval ${i} after the old one's late result`);
    }
    assert.strictEqual(h.entry.idle, false, 'the late result does not park the new process\'s turn');
    assert.ok(!h.entry.resultSent, 'nor mark its turn answered');
    assert.strictEqual(h.entry.responseText, 'Still working. ', 'nor touch the reply the new process is writing');
    assert.deepStrictEqual(late, [], 'nothing the replaced process printed reaches the screen: no text, no result, no done');
    emitFrom(next, wire.result('The new process answers.'));
    assert.strictEqual(h.entry.idle, true, 'control: the new process\'s own result parks the entry');
    assert.ok(h.sent.some(m => m.type === 'result' && m.result === 'The new process answers.'), 'and reaches the screen');
    const answered = h.beats('p1').length;
    t.mock.timers.tick(INTERVAL * 4);
    assert.strictEqual(h.beats('p1').length, answered, 'the new process\'s own result stops its heartbeat');
    assert.ok(!h.sent.some(m => JSON.stringify(m).includes('replaced process')),
      'and nothing the replaced process printed reached the screen later either');
  });

  test('no heartbeat timer outlives its process or holds the event loop open', (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    const w = watchIntervals();
    try {
      const h = harness();
      t.mock.timers.tick(INTERVAL);
      assert.strictEqual(h.beats('p1').length, 1, 'beating');
      h.emit(wire.result('First answer.'));
      giveNextTurn(h.entry);
      t.mock.timers.tick(INTERVAL);
      assert.strictEqual(h.beats('p1').length, 2, 'beating again on the next turn');
      h.proc.emit('close', 0);
      const failed = h.start('c2', 'p2');
      failed.entry.spawnFailed = true;
      t.mock.timers.tick(INTERVAL);
      assert.ok(w.made.length >= 3, `sanity: the heartbeat timers were seen (${w.made.length})`);
      for (const rec of w.made) {
        assert.ok(rec.unrefd, 'every heartbeat timer is unref\'d');
        assert.ok(w.cleared.has(rec.timer), 'every heartbeat timer is cleared once its turn or process is over');
      }
    } finally {
      w.restore();
    }
  });
});

describe('the five sequences', () => {
  test('the inverse: a turn that streams steadily sends what it sent before, with keepalives beside it', (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    const script = [wire.textDelta('One. '), wire.textDelta('Two. '), wire.textDelta('Three. '),
      wire.textDelta('Four. '), wire.textDelta('Five. '), wire.textDelta('Six.'), wire.messageStop(), wire.result('One. Two. Three. Four. Five. Six.')];
    const quick = harness();
    for (const o of script) quick.emit(o);
    const steady = harness();
    for (const o of script) { steady.emit(o); t.mock.timers.tick(10000); }
    const others = steady.sent.filter(m => !(m.type === 'system' && m.subtype === 'keepalive'));
    assert.deepStrictEqual(others, quick.sent.filter(m => !(m.type === 'system' && m.subtype === 'keepalive')),
      'every streamed message reaches the socket as before, in order');
    const resultAt = steady.sent.findIndex(m => m.type === 'result');
    assert.ok(steady.beats('p1').length >= 2, 'keepalives ran beside the stream');
    assert.ok(steady.sent.slice(resultAt).every(m => m.subtype !== 'keepalive'), 'and none after the result');
  });

  test('the undo: Stop ends it, nothing follows the close, the next message has its own heartbeat, and a late one is ignored', (t) => {
    t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
    const h = harness();
    h.emit(wire.compacting());
    t.mock.timers.tick(INTERVAL);
    const late = h.beats('p1')[0];
    assert.ok(late, 'beating during the quiet');
    const ctx = { processes: h.deps.processes, pendingPermissions: new Map(), broadcast: () => {} };
    processControl.handleCancel(ctx, null, { type: 'cancel', conversationId: 'c1' });
    h.proc.emit('close', null);
    t.mock.timers.tick(INTERVAL * 3);
    assert.strictEqual(h.beats('p1').length, 1, 'no keepalive after Stop and the close');
    const next = h.start('c1', 'p2');
    t.mock.timers.tick(INTERVAL);
    assert.strictEqual(h.beats('p2').length, 1, 'the next message starts a heartbeat of its own');
    assert.strictEqual(h.beats('p1').length, 1, 'and the stopped process stays silent');
    assert.strictEqual(next.entry.processId, 'p2');
    const state = { ...createState(), isProcessing: true, activeProcessId: 'p2', lastStreamActivity: 500 };
    const r = reduce(state, late, { now: 99999 });
    assert.strictEqual(r.state.lastStreamActivity, 500, 'a late keepalive from the old process is ignored by the stale check');
  });

  test('the retry: a second message after the result starts the heartbeat again, once', (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    const h = harness();
    t.mock.timers.tick(INTERVAL);
    h.emit(wire.result('First answer.'));
    h.entry.idle = true;
    const afterFirst = h.beats('p1').length;
    assert.strictEqual(afterFirst, 1, 'the first turn beat');
    giveNextTurn(h.entry);
    t.mock.timers.tick(INTERVAL * 2);
    assert.strictEqual(h.beats('p1').length - afterFirst, 2, 'one keepalive per interval on the second turn');
  });

  test('the most common next step: the summary ends, the answer streams, and the result ends the heartbeat', (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    const h = harness();
    h.emit(wire.compacting());
    t.mock.timers.tick(INTERVAL * 2);
    assert.strictEqual(h.beats('p1').length, 2, 'beating through the summary');
    h.emit(wire.compacted(), wire.boundary('b1'));
    t.mock.timers.tick(INTERVAL);
    assert.strictEqual(h.beats('p1').length, 3, 'still beating after the boundary, until the answer ends');
    h.emit(wire.textDelta('Here is the answer.'), wire.messageStop(), wire.result('Here is the answer.'));
    t.mock.timers.tick(INTERVAL * 3);
    assert.strictEqual(h.beats('p1').length, 3, 'the result ends it');
    const kinds = h.sent.filter(m => m.subtype !== 'keepalive').map(m => (m.type === 'system' ? m.subtype : m.type));
    assert.ok(kinds.indexOf('compact_boundary') >= 0 && kinds.indexOf('compact_boundary') < kinds.indexOf('result'),
      'the boundary and the result reach the socket as before, in order');
  });

  // The chat's own close handling, which tells the screen the turn is done and
  // lets the process go, lives in the server: a real killed process is driven
  // through it in test/integration/claude-keepalive.test.js.
  test('the control failing: a process killed mid-quiet stops at its close', (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    const h = harness();
    h.emit(wire.compacting());
    t.mock.timers.tick(INTERVAL);
    assert.strictEqual(h.beats('p1').length, 1, 'beating during the quiet');
    h.proc.emit('exit', null, 'SIGKILL');
    h.proc.emit('close', null, 'SIGKILL');
    t.mock.timers.tick(INTERVAL * 3);
    assert.strictEqual(h.beats('p1').length, 1, 'no keepalive after the close');
  });
});

describe('the interval override', () => {
  // A fresh engine reads the override at load, so each value gets its own.
  function engineWith(value) {
    const key = require.resolve(ENGINE);
    const saved = require.cache[key];
    const had = Object.prototype.hasOwnProperty.call(process.env, ENV);
    const prev = process.env[ENV];
    process.env[ENV] = value;
    delete require.cache[key];
    try {
      return require(ENGINE);
    } finally {
      if (had) process.env[ENV] = prev; else delete process.env[ENV];
      require.cache[key] = saved;
    }
  }

  const cases = [
    ['49', INTERVAL], ['50', 50], ['59999', 59999], ['60000', INTERVAL],
    ['0', INTERVAL], ['-100', INTERVAL], ['abc', INTERVAL], ['25.5', INTERVAL], ['', INTERVAL],
  ];
  for (const [value, expected] of cases) {
    test(`an override of ${JSON.stringify(value)} gives an interval of ${expected}`, (t) => {
      t.mock.timers.enable({ apis: ['setInterval'] });
      const h = harness({ lib: engineWith(value) });
      t.mock.timers.tick(expected - 1);
      assert.strictEqual(h.beats('p1').length, 0, `nothing before ${expected}ms`);
      t.mock.timers.tick(1);
      assert.strictEqual(h.beats('p1').length, 1, `a keepalive at ${expected}ms`);
    });
  }
});

describe('with no browser connected', () => {
  // Last in the file, with the failed start below: requiring the server builds
  // its own engine, which hands the shared engine module the server's real
  // safeSend.
  test('the server drops a keepalive into its reconnect buffer as it does any message, and nothing throws', (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    const { _internal: srv } = require(path.join(ROOT, 'server.js'));
    assert.strictEqual([...srv.connectedClients].length, 0, 'sanity: no browser is connected in this process');
    const entry = {
      process: fakeProcess(), agentId: 'alpha', processId: 'p-nobrowser', runtime: 'claude',
      buffer: '', responseText: '', toolCalls: [], exited: false, pendingAgentTools: [], deliveredTurns: [],
    };
    srv.wireProcessHandlers(entry, 'c-nobrowser', null, {});
    const before = srv.disconnectBuffer.length;
    assert.doesNotThrow(() => t.mock.timers.tick(INTERVAL));
    const buffered = srv.disconnectBuffer.slice(before).map(m => JSON.parse(m))
      .filter(m => m.subtype === 'keepalive' && m._processId === 'p-nobrowser');
    assert.strictEqual(buffered.length, 1, 'the keepalive went where every undelivered message goes');
    entry.process.emit('close', 0);
  });
});

describe('a Claude Code start that fails', () => {
  // Driven through the server's own spawn error handler, which every Claude
  // Code start is given before it is wired (spawnClaude in server.js and the
  // engine). The process emits 'error' after it is wired, as a start that
  // fails does, and may never close.
  test('a failed start sends no keepalive and its heartbeat is cleared when it fails, while a healthy process beside it beats', (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    const { _internal: srv } = require(path.join(ROOT, 'server.js'));
    const said = [];
    const client = { readyState: 1, send: (raw) => said.push(JSON.parse(raw)) };
    const entryFor = (processId) => ({
      process: fakeProcess(), agentId: 'alpha', processId, runtime: 'claude',
      buffer: '', responseText: '', toolCalls: [], exited: false, pendingAgentTools: [], deliveredTurns: [],
    });
    const healthy = entryFor('p-healthy');
    const failed = entryFor('p-failed');
    const w = watchIntervals();
    srv.connectedClients.add(client);
    try {
      srv.chatProcesses.set('c-healthy', healthy);
      srv.wireProcessHandlers(healthy, 'c-healthy', null, {});
      failed.process.on('error', (err) => srv.handleChatSpawnError(err, 'c-failed'));
      srv.chatProcesses.set('c-failed', failed);
      const before = w.made.length;
      srv.wireProcessHandlers(failed, 'c-failed', null, {});
      const failedTimers = w.made.slice(before).map((rec) => rec.timer);
      failed.process.emit('error', Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' }));
      const clearedAtFailure = failedTimers.filter((timer) => w.cleared.has(timer)).length;
      assert.strictEqual(failed.spawnFailed, true, 'sanity: the spawn error handler marked the failed start');
      assert.ok(said.some((m) => m._conversationId === 'c-failed' && m.subtype === 'done'), 'sanity: and told the screen it is done');
      assert.strictEqual(srv.chatProcesses.has('c-failed'), false, 'sanity: and let the failed process go');
      t.mock.timers.tick(INTERVAL * 2);
      const beats = (processId) => said.filter((m) => m.subtype === 'keepalive' && m._processId === processId);
      assert.strictEqual(beats('p-healthy').length, 2, 'control: the healthy process beats');
      assert.strictEqual(beats('p-failed').length, 0, 'no keepalive for a process that never started');
      assert.strictEqual(failedTimers.length, 1, 'the failed process was given a heartbeat when it was wired');
      assert.strictEqual(clearedAtFailure, 1, 'and its heartbeat was cleared when the start failed, not at its next tick');
    } finally {
      srv.connectedClients.delete(client);
      srv.chatProcesses.delete('c-healthy');
      srv.chatProcesses.delete('c-failed');
      healthy.process.emit('close', 0);
      w.restore();
    }
  });
});
