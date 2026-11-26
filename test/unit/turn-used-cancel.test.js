'use strict';
// HOW LONG A STOPPED TURN RAN, AS THE SERVER MEASURED IT.
//
// A turn the person stops never reaches its runtime's result, so the server
// says how long it ran: the time from the turn's start to the Stop, on the
// cancelled message the page draws the stopped reply from. A turn whose start
// the server never recorded carries no time at all, never a guess.
const { test, describe } = require('node:test');
const assert = require('node:assert');

const processControl = require('../../lib/protocol/handlers/process-control.js');

const CONVO = 'convo-stop';
const START = 1700000000000;

// Stop pressed at `now` on a running turn whose entry holds `turnStartTime`.
// The entry interrupts rather than kills, so nothing outside the test runs.
function stopAt(now, turnStartTime) {
  const entry = {
    processId: 'proc-1', agentId: 'researcher', toolCalls: [{ tool: 'Read', time: START + 1000 }],
    turnStartTime, exited: false, idle: false, interrupt: () => {},
  };
  const processes = new Map([[CONVO, entry]]);
  const sent = [];
  const ctx = { processes, pendingPermissions: new Map(), broadcast: (m) => sent.push(JSON.parse(m)) };
  const realNow = Date.now;
  Date.now = () => now;
  try {
    processControl.handleCancel(ctx, null, { type: 'cancel', conversationId: CONVO });
  } finally {
    Date.now = realNow;
  }
  const cancelled = sent.filter((m) => m.type === 'system' && m.subtype === 'cancelled');
  assert.strictEqual(cancelled.length, 1, 'one cancelled message');
  return { cancelled: cancelled[0], sent };
}

describe('the cancelled message', () => {
  test('carries the time from the turn\'s start to the Stop', () => {
    const { cancelled } = stopAt(START + 72000, START);
    assert.strictEqual(cancelled.duration_ms, 72000);
  });

  test('a Stop in the turn\'s first moment carries 0', () => {
    const { cancelled } = stopAt(START, START);
    assert.strictEqual(cancelled.duration_ms, 0);
  });

  test('keeps every field it carried before', () => {
    const { cancelled } = stopAt(START + 72000, START);
    assert.deepStrictEqual(cancelled, {
      type: 'system', subtype: 'cancelled',
      _conversationId: CONVO, _processId: 'proc-1', _agent: 'researcher',
      _toolCalls: [{ tool: 'Read', time: START + 1000 }], _turnStartTime: START,
      duration_ms: 72000,
    });
  });

  // Each is paired with a turn whose start was recorded, stopped at the same
  // moment, so the one that carries no time is told apart from a message that
  // never carries one.
  for (const [label, start] of [['no start', undefined], ['a null start', null], ['a start sent as text', String(START)], ['a start of NaN', NaN], ['an infinite start', Infinity]]) {
    test(`a turn with ${label} carries no time, where a recorded start carries the measured time`, () => {
      const { cancelled: timed } = stopAt(START + 72000, START);
      assert.strictEqual(timed.duration_ms, 72000, 'a recorded start gives the time to the Stop');
      const { cancelled } = stopAt(START + 72000, start);
      assert.ok(!Object.prototype.hasOwnProperty.call(cancelled, 'duration_ms'), 'no duration_ms key');
    });
  }

  test('the time rides on the cancelled message, and the done that follows carries none of its own', () => {
    const { sent, cancelled } = stopAt(START + 72000, START);
    assert.strictEqual(cancelled.duration_ms, 72000, 'the cancelled message carries the time to the Stop');
    const done = sent.find((m) => m.type === 'system' && m.subtype === 'done');
    assert.ok(done, 'done is sent');
    assert.ok(!Object.prototype.hasOwnProperty.call(done, 'duration_ms'));
  });
});
