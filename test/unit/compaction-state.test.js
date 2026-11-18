'use strict';
// What the window decides when a conversation is summarised to make room:
// public/conversation-state.js, fed the lines Claude Code really wrote
// (test/fixtures/compaction/claude-compact.jsonl, scrubbed) and the shapes
// the server sends on for a Codex summary.
//
// The divider is drawn only from the runtime's own system message. The words
// it shows, and either runtime's event spelled out as text, reach the window
// only inside a reply, a tool result or the person's own message, and none of
// those draws one.
const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { createState, reduce } = require('../../public/conversation-state.js');

const CAPTURE = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'compaction', 'claude-compact.jsonl'), 'utf8')
  .trim().split('\n').map((l) => JSON.parse(l));
const tag = { _agent: 'example-agent', _conversationId: 'convo-a', _processId: 'p1' };
const DIVIDER_EFFECTS = ['show-summarising', 'insert-compaction-divider', 'clear-summarising'];

function started() {
  let state = createState();
  ({ state } = reduce(state, { type: 'system', subtype: 'process_started', ...tag }, { isActive: true }));
  return state;
}

// Runs messages through the reducer as the window would, and returns only the
// effects this change adds.
function feed(messages, ctx = {}) {
  let state = started();
  const effects = [];
  for (const m of messages) {
    const out = reduce(state, m, { isActive: true, convoAgentId: 'example-agent', ...ctx });
    state = out.state;
    effects.push(...out.effects.filter((e) => DIVIDER_EFFECTS.includes(e.type)));
  }
  return effects;
}

describe('Claude Code\'s own lines', () => {
  test('the captured summary: the start shows the live line, the boundary draws one divider keyed by its uuid', () => {
    const boundary = CAPTURE.find((l) => l.subtype === 'compact_boundary');
    const effects = feed(CAPTURE.map((l) => ({ ...l, ...tag })));
    assert.deepStrictEqual(effects, [
      { type: 'show-summarising', agentId: 'example-agent' },
      { type: 'insert-compaction-divider', key: boundary.uuid, agentId: 'example-agent' },
    ]);
  });

  test('the summary Claude Code writes as a user line draws nothing: the window never shows it', () => {
    const summary = CAPTURE.find((l) => l.type === 'user' && l.isSynthetic);
    assert.ok(summary, 'the capture holds the summary line');
    assert.deepStrictEqual(feed([{ ...summary, ...tag }]), []);
  });

  test('a boundary the conversation already holds draws nothing more, and still settles the live line', () => {
    const boundary = { ...CAPTURE.find((l) => l.subtype === 'compact_boundary'), ...tag };
    assert.deepStrictEqual(feed([boundary], { knownCompactionKeys: [boundary.uuid] }), [{ type: 'clear-summarising' }]);
  });

  test('two summaries give two dividers, in order', () => {
    const effects = feed([
      { type: 'system', subtype: 'compact_boundary', uuid: 'first', ...tag },
      { type: 'system', subtype: 'compact_boundary', uuid: 'second', ...tag },
    ]);
    assert.deepStrictEqual(effects.map((e) => e.key), ['first', 'second']);
  });

  test('a status cleared without success takes the live line away and draws no divider', () => {
    const effects = feed([
      { type: 'system', subtype: 'status', status: 'compacting', ...tag },
      { type: 'system', subtype: 'status', status: null, compact_result: 'failed', ...tag },
    ]);
    assert.deepStrictEqual(effects.map((e) => e.type), ['show-summarising', 'clear-summarising']);
  });

  test('a status from a process that no longer owns the conversation shows nothing', () => {
    assert.deepStrictEqual(feed([{ type: 'system', subtype: 'status', status: 'compacting', ...tag, _processId: 'old' }]), []);
  });
});

describe('a boundary missing what it needs, or of another shape', () => {
  for (const [label, message] of [
    ['no uuid', { type: 'system', subtype: 'compact_boundary' }],
    ['an empty uuid', { type: 'system', subtype: 'compact_boundary', uuid: '' }],
    ['a uuid that is not a string', { type: 'system', subtype: 'compact_boundary', uuid: 7 }],
    ['an unknown status', { type: 'system', subtype: 'status', status: 'tidying' }],
    ['a top-level type no runtime sends', { type: 'compact_boundary', uuid: 'x' }],
  ]) {
    test(`${label}: draws nothing, and the turn carries on`, () => {
      let state = started();
      const out = reduce(state, { ...message, ...tag }, { isActive: true });
      assert.deepStrictEqual(out.effects.filter((e) => DIVIDER_EFFECTS.includes(e.type)), []);
      state = out.state;
      const after = reduce(state, { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Carrying on.' } }, ...tag }, { isActive: true });
      assert.strictEqual(after.state.streamingRawText, 'Carrying on.', 'the reply still streams');
    });
  }
});

describe('look-alikes in text draw nothing', () => {
  const WORDS = 'Earlier messages were summarised to make room. Summarising earlier messages…';
  const SHAPES = [
    JSON.stringify({ type: 'system', subtype: 'compact_boundary', uuid: 'fake', compact_metadata: { trigger: 'auto' } }),
    JSON.stringify({ type: 'system', subtype: 'status', status: 'compacting' }),
    JSON.stringify({ method: 'thread/compacted', params: { threadId: 'x', turnId: 'y' } }),
    JSON.stringify({ method: 'item/completed', params: { item: { type: 'contextCompaction', id: 'z' } } }),
  ];
  const TEXT = [WORDS, ...SHAPES].join('\n');

  test('in an agent\'s reply, streamed and whole, and in its result', () => {
    const effects = feed([
      { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: TEXT } }, ...tag },
      { type: 'assistant', message: { content: [{ type: 'text', text: TEXT }] }, ...tag },
      { type: 'result', subtype: 'success', result: TEXT, ...tag },
    ]);
    assert.deepStrictEqual(effects, []);
  });

  test('in a tool\'s result', () => {
    const effects = feed([
      { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: TEXT }] }, ...tag },
      { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_2', content: [{ type: 'text', text: TEXT }] }] }, ...tag },
    ]);
    assert.deepStrictEqual(effects, []);
  });

  test('in the person\'s own message', () => {
    assert.deepStrictEqual(feed([{ type: 'user', message: { role: 'user', content: TEXT }, ...tag }]), []);
  });

  test('a system line that only mentions a summary', () => {
    const effects = feed([
      { type: 'system', subtype: 'info', message: WORDS, ...tag },
      { type: 'system', subtype: 'error', error: SHAPES[0], ...tag },
      { type: 'raw', content: SHAPES[0], ...tag },
    ]);
    assert.deepStrictEqual(effects, []);
  });
});
