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
const fs = require('node:fs');

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

describe('a delegation that reached nobody is recorded, not swallowed', () => {
  // DRIVEN, not read. The engine resolves a target through discoverAgents, so
  // the harness gets a real workspace on disk first and the interception then
  // runs for real over a real stdout stream.
  const { makeWorkspace, agentFile } = require(path.join(ROOT, 'test', 'helpers', 'workspace.js'));
  const config = require(path.join(ROOT, 'lib', 'config.js'));

  function team() {
    return {
      roo: agentFile({ name: 'roo', displayName: 'Roo', role: 'Orchestrator', description: 'routes', type: 'orchestrator', order: 0, body: 'You route.' }),
      'research-lead': agentFile({ name: 'research-lead', displayName: 'Ren', role: 'Research Lead', description: 'researches', type: 'specialist', order: 1, reportsTo: 'roo', body: 'You research.' }),
      'fact-checker': agentFile({ name: 'fact-checker', displayName: 'Sage', role: 'Fact Checker', description: 'verifies', type: 'specialist', order: 2, reportsTo: 'research-lead', body: 'You verify.' }),
    };
  }

  // An Agent tool call as the runtime streams one.
  const agentCall = (input) => ([
    { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', name: 'Agent', id: 't1' } } },
    { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } } },
    { type: 'stream_event', event: { type: 'content_block_stop', index: 0 } },
  ]);

  function withTeam(agentId, fn) {
    const dir = makeWorkspace({ agents: team(), claudeMd: '# Test\n' });
    const before = config.getWorkspace();
    config.setWorkspace(dir);
    const logged = [];
    const realLog = console.log;
    console.log = (...a) => { logged.push(a.join(' ')); };
    try {
      const h = harness({ agentId, interception: true });
      return fn(h, logged, dir);
    } finally { console.log = realLog; config.setWorkspace(before); }
  }

  // The events the engine actually wrote, read back off disk. recordEvent
  // appends to the workspace, so with a real workspace there is no need to
  // inject a spy and pretend: the effect is a file, and this reads the file.
  // Written asynchronously, so a short wait beats a race.
  async function eventsWritten(dir) {
    const stateDir = path.join(dir, '.rundock', 'state');
    for (let i = 0; i < 40; i++) {
      try {
        const f = fs.readdirSync(stateDir).find((n) => n.startsWith('events-'));
        if (f) {
          const lines = fs.readFileSync(path.join(stateDir, f), 'utf-8').split('\n').filter(Boolean);
          if (lines.length) return lines.map((l) => JSON.parse(l));
        }
      } catch (e) { /* not written yet */ }
      await new Promise((r) => setTimeout(r, 25));
    }
    return [];
  }

  // A successful delegation's effect is asserted where a delegate can actually
  // be spawned:
  // test/integration/delegation-target.test.js drives a real handoff against
  // the stub runtime and reads the agent_switch. This harness cannot, because
  // there is no runtime for handleDelegation to start, so asserting the switch
  // here would only ever prove the spawn failed. What it proves instead is the
  // half it can: which calls are treated as a missed delegation and which are
  // not.

  test('a lead whose call names nobody is recorded as a miss', async () => {
    // The shape that used to pass in silence. Asserted on the event the
    // engine wrote, not only on what it printed.
    const out = withTeam('research-lead', (h, logged, dir) => {
      h.emit(...agentCall({ description: 'Looking into the pricing page.', prompt: 'have a look at this' }));
      h.emit(wire.messageStop());
      return { logged, dir, sent: h.sent };
    });

    assert.ok(!out.sent.some((m) => m.subtype === 'agent_switch'),
      'sanity: nothing was delegated, which is the case under test');

    const events = await eventsWritten(out.dir);
    const miss = events.find((e) => e.e === 'delegation_error' && (e.d || {}).reason === 'no_target_matched');
    assert.ok(miss, `the miss is recorded where the other delegation errors are: ${JSON.stringify(events)}`);
    assert.strictEqual(miss.agent, 'research-lead', 'naming who made the call');
    // THE WHOLE PAYLOAD, not one key. Asserting a single field says nothing
    // about what else the event grew: a check that a key is absent cannot fail
    // while that key has never existed, and a check that one key is present
    // passes while three more leak in beside it. Pinning the entire object is
    // what makes this assertion able to fail.
    assert.deepStrictEqual(miss.d, {
      reason: 'no_target_matched',
      asked: 'Looking into the pricing page.',
    }, 'the record says which handover a person was told about and never got, and nothing more');
  });

  test('a turn that delegates once and misses once records the miss', async () => {
    // PER CALL. One call matching a report says nothing about the others: each
    // is its own handover. Recording only when the whole turn missed would
    // have hidden every miss that shared a turn with a successful delegation,
    // which is the likeliest place for one to hide.
    const out = withTeam('research-lead', (h, logged, dir) => {
      h.emit(...agentCall({ description: 'Handing to Sage to check the figures.', prompt: 'verify these' }));
      h.emit(...agentCall({ description: 'Looking into the pricing page.', prompt: 'have a look' }));
      h.emit(wire.messageStop());
      return { dir, logged };
    });

    const events = await eventsWritten(out.dir);
    const misses = events.filter((e) => (e.d || {}).reason === 'no_target_matched');
    assert.strictEqual(misses.length, 1,
      `exactly the one that named nobody: ${JSON.stringify(misses)}`);
    assert.strictEqual(misses[0].d.asked, 'Looking into the pricing page.',
      'and it is the call that missed, not the one that found its target');
    const missLines = out.logged.filter((l) => l.includes('no target the roster matched'));
    assert.strictEqual(missLines.length, 1, 'and it is reported once, not once per call in the turn');
    assert.ok(!missLines[0].includes('check the figures'),
      'the successful handover is nobody\'s miss');
  });

  test('an agent that leads nobody is not reported at all', () => {
    // Scope. Sage has no reports, so her generic subagent is not a
    // failed handover and saying so would be noise.
    const out = withTeam('fact-checker', (h, logged) => {
      h.emit(...agentCall({ description: 'Checking a source.', prompt: 'go and read this page' }));
      h.emit(wire.messageStop());
      return { logged };
    });
    assert.ok(!out.logged.some((l) => /no target the roster matched/.test(l)),
      'an agent with nobody to delegate to cannot have missed a delegation');
  });

  test('and nothing is recorded for it either', async () => {
    const out = withTeam('fact-checker', (h, logged, dir) => {
      h.emit(...agentCall({ description: 'Checking a source.', prompt: 'go and read this page' }));
      h.emit(wire.messageStop());
      return { dir };
    });
    const events = await eventsWritten(out.dir);
    assert.deepStrictEqual(events.filter((e) => (e.d || {}).reason === 'no_target_matched'), [],
      'the record stays worth reading by only holding real misses');
  });

  test('an explicit built-in target is not reported as a miss either', () => {
    // A deliberate choice, left alone.
    const out = withTeam('research-lead', (h, logged) => {
      h.emit(...agentCall({ subagent_type: 'general-purpose', description: 'Handing to Sage to fact-check.', prompt: 'check it' }));
      h.emit(wire.messageStop());
      return { logged };
    });
    assert.ok(!out.logged.some((l) => /no target the roster matched/.test(l)),
      'the caller asked for a general-purpose subagent and got one');
    assert.ok(!out.logged.some((l) => /intercepting Agent tool call/.test(l)),
      'and naming a teammate in the sentence did not hijack it');
  });
});
