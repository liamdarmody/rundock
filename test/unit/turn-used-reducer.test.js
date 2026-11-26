'use strict';
// WHAT A RESULT SAYS ITS TURN USED, CARRIED TO THE PAGE.
//
// The reducer hands the view the runtime's own duration, its token counts and
// which runtime reported them, on the two effects that draw a reply's line and
// on the stopped-turn badge. It passes them as they came: the view checks each
// value before it draws anything from it.
const { test } = require('node:test');
const assert = require('node:assert');
const { createState, reduce } = require('../../public/conversation-state.js');
const sj = require('../fixtures/stream-json.js');

const CONVO = 'convo-1';
const START = 1700000000000;
const LIVE = { isActive: true, viewingChat: true, convoExists: true, convoInWorkspace: true, delegationTriggered: false };
const USAGE = { input_tokens: 18240, output_tokens: 3905 };

function result(extra) {
  const msg = sj.result({ text: 'Done.', extra: { _conversationId: CONVO, _turnStartTime: START, _toolCalls: [{ tool: 'Read', time: START + 1000 }], ...extra } });
  if (!Object.prototype.hasOwnProperty.call(extra, 'duration_ms')) delete msg.duration_ms;
  return msg;
}
function effectOf(type, state, message) {
  const { effects } = reduce(state, message, LIVE);
  const found = effects.find((e) => e.type === type);
  assert.ok(found, `${type} is emitted`);
  return found;
}
const streaming = () => ({ ...createState(), isProcessing: true, hasStreamingBubble: true });
const quiet = () => ({ ...createState(), isProcessing: true, hasStreamingBubble: false });

test('a streamed reply\'s finish carries the runtime\'s duration, usage and runtime', () => {
  const ef = effectOf('finalize-stream-bubble', streaming(), result({ duration_ms: 245000, usage: USAGE }));
  assert.strictEqual(ef.durationMs, 245000);
  assert.deepStrictEqual(ef.usage, USAGE);
  assert.strictEqual(ef.runtime, 'claude');
  assert.strictEqual(ef.turnStartTime, START, 'the step times are as before');
});

test('a short reply drawn at the end carries the runtime\'s duration, usage and runtime', () => {
  const ef = effectOf('append-final-message', quiet(), result({ duration_ms: 48000, usage: USAGE }));
  assert.strictEqual(ef.durationMs, 48000);
  assert.deepStrictEqual(ef.usage, USAGE);
  assert.strictEqual(ef.runtime, 'claude');
});

test('a Codex result says it is Codex\'s', () => {
  const usage = { inputTokens: 900, outputTokens: 40 };
  const ef = effectOf('finalize-stream-bubble', streaming(), result({ duration_ms: 14779, usage, _runtime: 'codex' }));
  assert.strictEqual(ef.runtime, 'codex');
  assert.strictEqual(ef.durationMs, 14779);
  assert.deepStrictEqual(ef.usage, usage);
});

test('a runtime other than codex is passed on as Claude Code', () => {
  for (const runtime of ['Codex', 'other', 7, null]) {
    const ef = effectOf('append-final-message', quiet(), result({ duration_ms: 1000, _runtime: runtime }));
    assert.strictEqual(ef.runtime, 'claude', String(runtime));
  }
});

test('the values pass as they came, for the view to check', () => {
  const ef = effectOf('append-final-message', quiet(), result({ duration_ms: '245000', usage: [1, 2] }));
  assert.strictEqual(ef.durationMs, '245000');
  assert.deepStrictEqual(ef.usage, [1, 2]);
  assert.strictEqual(ef.runtime, 'claude');
});

test('a stopped turn\'s badge carries the duration the server measured', () => {
  const ef = effectOf('add-cancelled-badge', streaming(), {
    type: 'system', subtype: 'cancelled', _conversationId: CONVO, _toolCalls: [{ tool: 'Read' }], _turnStartTime: START, duration_ms: 72000,
  });
  assert.strictEqual(ef.durationMs, 72000);
  assert.deepStrictEqual(ef.toolCalls, [{ tool: 'Read' }]);
  assert.strictEqual(ef.turnStartTime, START);
});

test('a stopped turn the server could not time carries no duration, where a timed one carries its own', () => {
  const { effects } = reduce(streaming(), { type: 'system', subtype: 'cancelled', _conversationId: CONVO, _toolCalls: [], _turnStartTime: null }, LIVE);
  const ef = effects.find((e) => e.type === 'add-cancelled-badge');
  assert.ok(ef);
  assert.strictEqual(ef.durationMs, undefined);
  const timed = reduce(streaming(), { type: 'system', subtype: 'cancelled', _conversationId: CONVO, _toolCalls: [], _turnStartTime: START, duration_ms: 72000 }, LIVE)
    .effects.find((e) => e.type === 'add-cancelled-badge');
  assert.ok(timed, 'the timed stop draws its badge');
  assert.strictEqual(timed.durationMs, 72000, 'a stop the server timed carries that time');
});

// Pins what main already does (the stored reply); its sibling "a streamed
// reply's finish carries the runtime's duration, usage and runtime" shares the
// setup and fails on main.
test('the reply kept for the conversation holds its words alone, never what the turn used', () => {
  const ef = effectOf('finalize-agent-message', streaming(), result({ duration_ms: 245000, usage: USAGE, total_cost_usd: 0.0282 }));
  assert.deepStrictEqual(Object.keys(ef).sort(), ['agentId', 'attribution', 'text', 'type']);
  assert.strictEqual(ef.text, 'Done.');
});
